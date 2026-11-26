/**
 * @file ChRIS Connection Management
 *
 * This module provides the `ChRISConnection` class, responsible for managing
 * the connection to a ChRIS CUBE, including authentication, token handling,
 * and context setting. It abstracts away the underlying storage mechanisms
 * for configuration and tokens using `IStorageProvider`.
 *
 * @module
 */

import { folderLookup_memoize } from '../filebrowser/folderMemo';
import { requestLedger_start } from '../net/requestLedger';
import { Client, authToken_get as adapterAuthToken_get, client_create, token_verify, TOKEN_CHECK_TIMEOUT_MS } from "../chrisapi/adapter.js";
import { loginFailure_diagnose, loginFailure_lines, url_probe, type LoginFailure } from "./loginFailure.js";
import { ConnectionConfig, config_init, connectionConfig } from "../config/config.js";
import {
  chrisContextURL_parse,
  SingleContext,
  Context,
  chrisContext,
} from "../context/chrisContext.js";
import { IStorageProvider } from "../io/io.js";
import { chrisIO } from "../io/chrisIO.js";
import { errorStack } from "../error/errorStack.js";
import chalk from "chalk";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Re-exports the ChRIS API client for convenience.
 */
export { Client };

/**
 * Interface defining options for establishing a ChRIS connection.
 */
interface ConnectOptions {
  user: string;
  password: string;
  debug: boolean;
  url: string;
}

/** What a login door hands over: an identity and a CUBE token minted for it. */
export interface TokenConnectOptions {
  user: string;
  url: string;
  token: string;
}

/** Whether a handed-over token was accepted, and if not, what the server said. */
export interface TokenConnectOutcome {
  connected: boolean;
  reason?: string;
}

/** Credentials used to obtain a short-lived elevated CUBE token. */
export interface ElevationCredentials {
  username: string;
  password: string;
}

/**
 * Helper function to validate and format a context string.
 * @param context - The context string to check.
 * @returns The formatted context string.
 */
function contextString_check(context: string): string {
  if (context.includes("://")) {
    return context;
  }
  if (context.startsWith("?")) {
    return context;
  }
  return "?" + context;
}

/**
 * Whether a failed request got an answer from CUBE (chrisapi keeps the
 * response on its error when one came back).
 *
 * @param error - What the request threw.
 * @returns True when CUBE answered.
 */
function response_has(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { response?: unknown }).response !== undefined;
}

/**
 * Manages the connection and authentication with a ChRIS CUBE.
 */
export class ChRISConnection {
  private authToken: string | null = null;
  private tokenFile!: string;
  private user: string | null = null;
  private chrisURL: string | null = null;
  private client: Client | null = null;
  private _config?: ConnectionConfig; // Renamed backing field
  private storageProvider?: IStorageProvider; // Made optional
  private readonly elevatedClientContext: AsyncLocalStorage<Client> = new AsyncLocalStorage<Client>();

  /**
   * Constructs a new ChRISConnection instance.
   * @param config - The connection configuration object.
   * @param storageProvider - The storage provider for persistence.
   */
  constructor(config?: ConnectionConfig, storageProvider?: IStorageProvider) {
    // Every request the session makes is counted from the moment there is
    // a session to make them (netstat reads the ledger).
    requestLedger_start();
    if (config && storageProvider) {
      this.init(config, storageProvider);
    }
    // Ensure that config and storageProvider are not undefined if no args were passed.
    // This allows the initial `new ChRISConnection()` to create a valid, though uninitialized, object.
    this._config = config;
    this.storageProvider = storageProvider;
  }

  /**
   * Access the connection configuration.
   */
  public get config(): ConnectionConfig | undefined {
    return this._config;
  }

  /**
   * Initializes the connection with configuration and storage provider.
   * @param config - The connection configuration object.
   * @param storageProvider - The storage provider for persistence.
   */
  /** How a failed login asks the network what happened; a test stands one in. */
  public loginProbe: (url: string) => Promise<string | null> = url_probe;

  init(config: ConnectionConfig, storageProvider: IStorageProvider) {
    this._config = config;
    this.storageProvider = storageProvider;
    this.tokenFile = this._config.tokenFilepath;
  }

  /**
   * Establishes a connection to the ChRIS CUBE and authenticates the user.
   * @param options - Connection options including user, password, debug flag, and URL.
   * @returns A Promise resolving to the authentication token on success, or null on failure.
   */
  async connection_connect(options: ConnectOptions): Promise<string | null> {
    const { user, password, debug, url }: ConnectOptions = options;

    // Ensure configuration is initialized before use
    if (this.storageProvider) {
      await config_init(this.storageProvider);
      this._config = connectionConfig;
    }

    const authUrl: string = url + "auth-token/";
    this.user = user;
    this.chrisURL = url;
    console.log(`Connecting to ${url} with user ${user}`);
    await this._config!.context_set(user, url);
    this.tokenFile = this._config!.tokenFilepath;
    try {
      this.authToken = await adapterAuthToken_get(authUrl, user, password);
      if (this.authToken) {
        // console.log("Auth token: " + this.authToken);
        const saved: boolean = await this.token_saveToFile(this.tokenFile, this.authToken);
        // Said only when it is so: a token that could not be saved privately is held for this session and not on disk.
        console.log(saved ? "Auth token saved successfully" : "Auth token held for this session; it was not saved");
        console.log("ChRIS URL saved successfully");
        return this.authToken;
      } else {
        console.log("Failed to receive auth token");
        return null;
      }
    } catch (error: unknown) {
      // The real cause, said as what it is: only CUBE's refusal blames the
      // credentials; an untrusted certificate or an unreachable host says so (#965).
      const failure: LoginFailure = await loginFailure_diagnose(error, authUrl, this.loginProbe);
      console.error('');
      for (const line of loginFailure_lines(failure, url)) console.error(line);
      console.error("\nExiting to system with code 1...");
      if (debug) {
        throw error;
      }
      process.exit(1);
    }
  }

  /**
   * Proves a token against a CUBE without reading its root, which is the
   * feed list and can outlast the check for an identity that sees thousands
   * of feeds (#1280).
   *
   * @param url - Base URL of the CUBE API, ending in `/`.
   * @param token - The token to prove.
   * @throws {Error} chrisapi's error: carrying CUBE's response when it
   *   refused, "No server response!" when nothing came back.
   */
  async token_check(url: string, token: string): Promise<void> {
    await token_verify(url, token);
  }

  /**
   * Establishes a connection from a CUBE token somebody else already minted.
   *
   * The password path exchanges a password for a token and saves it. A front
   * that authenticated the operator itself — a login door on a shared host —
   * holds the token and never the password, so it hands the token over as
   * it is. The token is proved against the server BEFORE anything is
   * written: a refused token leaves the saved context and the last-user
   * pointer exactly as they were. Nothing here exits the process, and
   * nothing lands on the error stack; the refusal travels in the outcome,
   * because the caller is a boot that has its own row to write.
   *
   * @param options - The identity the token was minted for, and the token.
   * @returns Connected, or refused with the server's reason.
   */
  async connection_connectWithToken(options: TokenConnectOptions): Promise<TokenConnectOutcome> {
    const { user, url, token }: TokenConnectOptions = options;
    if (this.storageProvider) {
      await config_init(this.storageProvider);
      this._config = connectionConfig;
    }
    const client: Client = client_create(url, token);
    try {
      await token_verify(url, token);
    } catch (error: unknown) {
      const failure: LoginFailure = await loginFailure_diagnose(error, url, this.loginProbe);
      if (failure.kind === 'tls' || failure.kind === 'network') {
        return { connected: false, reason: loginFailure_lines(failure, url).join(' ') };
      }
      // Nothing back is not a refusal: a busy CUBE that outlasted the
      // check said nothing about the token (#1280).
      if (!response_has(error)) {
        return { connected: false, reason: `${url} did not answer the token check for ${user} within ${TOKEN_CHECK_TIMEOUT_MS / 1000} s; CUBE may be busy, try again` };
      }
      const reason: string = error instanceof Error ? error.message : String(error);
      return { connected: false, reason: `${url} refused the token for ${user}: ${reason}` };
    }
    this.user = user;
    this.chrisURL = url;
    await this._config!.context_set(user, url);
    this.tokenFile = this._config!.tokenFilepath;
    this.authToken = token;
    // One folder lookup per path per session, as client_get makes it.
    this.client = folderLookup_memoize(client);
    await this.token_saveToFile(this.tokenFile, token);
    return { connected: true };
  }

  /**
   * Sets the ChRIS context based on a context string (e.g., user@url?folder=...). 
   * @param context - The context string.
   * @returns A Promise resolving to true on success, false otherwise.
   */
  async context_set(context: string): Promise<boolean> {
    context = contextString_check(context);
    const parsedContext: SingleContext = await chrisContextURL_parse(context);

    if (errorStack.messagesOfType_has('error')) {
      const error = errorStack.stack_pop();
      console.error(chalk.red('Context error:', error?.message));
      // Clear any remaining errors to prevent them from affecting subsequent operations
      errorStack.type_clear('error');
      return false;
    }

    let status: boolean = true;
    let needsRefresh: boolean = false;

    if (parsedContext.user) {
      status =
        status &&
        (await chrisContext.current_set(Context.ChRISuser, parsedContext.user)); // Await this call
      this.user = parsedContext.user;
      needsRefresh = true;
      await this._config!.context_set(
        parsedContext.user,
        parsedContext.URL || ''
      );
    }

    if (parsedContext.URL) {
      status =
        status && (await chrisContext.current_set(Context.ChRISURL, parsedContext.URL)); // Await this call
      this.chrisURL = parsedContext.URL;
      needsRefresh = true;
      await this._config!.context_set(this.user || "", parsedContext.URL);
    }

    if (parsedContext.folder) {
      status =
        status &&
        (await chrisContext.current_set(Context.ChRISfolder, parsedContext.folder)); // Await this call
    }

    if (parsedContext.feed) {
      status =
        status &&
        (await chrisContext.current_set(Context.ChRISfeed, parsedContext.feed)); // Await this call
    }

    if (parsedContext.plugin) {
      status =
        status &&
        (await chrisContext.current_set(Context.ChRISplugin, parsedContext.plugin)); // Await this call
    }

    // Refresh the client with the new context
    if (needsRefresh) {
      await this.client_refresh();
    }

    return status;
  }

  /**
   * Retrieves the authentication token.
   * @param forceLoad - If true, forces loading the token from storage.
   * @returns A Promise resolving to the authentication token or null.
   */
  async authToken_get(forceLoad?: boolean): Promise<string | null> {
    if (!this.authToken || forceLoad) {
      await this.token_load();
    }
    return this.authToken;
  }

  /**
   * Retrieves the current authenticated user's username.
   * @returns A Promise resolving to the username string or null if not authenticated.
   */
  async user_get(): Promise<string | null> {
    // Ensure token is loaded if not already present, as user is set during connection.
    if (!this.user && this.authToken) {
      // Re-load config if necessary, or simply return stored user.
      // For now, assume this.user is reliably set during connection_connect
      // or if auth token is loaded from storage (which would imply context reload).
      // A more robust implementation might re-derive user from token or context.
    }
    return this.user;
  }

  /**
   * Retrieves the ChRIS CUBE URL.
   * @returns A Promise resolving to the ChRIS URL or null.
   */
  async chrisURL_get(): Promise<string | null> {
    if (!this.chrisURL) {
      if (!this._config) {
        return null; // config not initialized
      }
      this.chrisURL = await this._config.chrisURL_load();
    }
    return this.chrisURL;
  }

  /**
   * Refreshes the ChRIS API client with current token and URL.
   * @returns A Promise resolving to the refreshed Client instance or null.
   */
  async client_refresh(): Promise<Client | null> {
    this.tokenFile = this._config!.tokenFilepath;
    this.chrisURL = await this.chrisURL_get();
    this.authToken = await this.authToken_get(true); // Pass true directly
    if (this.chrisURL && this.authToken) {
      this.client = folderLookup_memoize(client_create(this.chrisURL, this.authToken));
    }
    return this.client;
  }

  /**
   * Retrieves the ChRIS API client instance.
   * @returns A Promise resolving to the Client instance or null.
   */
  async client_get(): Promise<Client | null> {
    const elevatedClient: Client | undefined = this.elevatedClientContext.getStore();
    if (elevatedClient) return elevatedClient;

    if (
      (await this.authToken_get()) &&
      (await this.chrisURL_get()) &&
      this.chrisURL &&
      this.authToken
    ) {
      if (!this.client) {
        // One folder lookup per path per session (see filebrowser/folderMemo).
        this.client = folderLookup_memoize(client_create(this.chrisURL, this.authToken));
      }
    }
    return this.client;
  }

  /**
   * Executes one operation with a non-persistent CUBE client for supplied
   * credentials. The client follows only the nested operation's asynchronous
   * context, so concurrent normal and elevated commands retain their own
   * identities.
   *
   * The normal session token, cached client, and token storage remain intact.
   *
   * @param credentials - Credentials for the requested CUBE identity.
   * @param operation - Work to perform while the temporary client is active.
   * @returns The operation's result.
   * @throws {Error} When no CUBE URL is available or authentication fails.
   */
  async elevation_runWithCredentials<T>(
    credentials: ElevationCredentials,
    operation: () => Promise<T>,
  ): Promise<T> {
    const url: string | null = await this.chrisURL_get();
    if (!url) throw new Error('Not connected to ChRIS. Run connect first.');

    let token: string;
    try {
      token = await adapterAuthToken_get(`${url}auth-token/`, credentials.username, credentials.password);
    } catch (error: unknown) {
      // A refusal is the credentials' to answer for; a certificate or a
      // network failure says what it is instead (#965).
      const failure: LoginFailure = await loginFailure_diagnose(error, `${url}auth-token/`, this.loginProbe);
      if (failure.kind === 'tls' || failure.kind === 'network') throw new Error(loginFailure_lines(failure, url).join(' '));
      throw error;
    }
    const elevatedClient: Client = client_create(url, token);
    return await this.elevatedClientContext.run(elevatedClient, operation);
  }

  /**
   * Checks if the client is currently connected.
   * @returns True if connected, false otherwise.
   */
  connection_isConnected(): boolean {
    return this.authToken !== null;
  }

  /**
   * Logs out the user by clearing the authentication token from storage.
   */
  async connection_logout(): Promise<void> {
    this.authToken = null;
    try {
      await this.storageProvider!.remove(this.tokenFile);
      console.log("Logged out successfully");
    } catch (error: unknown) {
      console.error("Error during logout:", error);
    }
  }

  /**
   * Saves data to a specified file using the storage provider.
   * @param file - The path to the file.
   * @param info - The string data to save.
   * @returns Whether it was saved; false when it could not be, or could not be saved privately.
   */
  private async token_saveToFile(file: string, info: string): Promise<boolean> {
    const store: IStorageProvider = this.storageProvider!;
    try {
      // A token is a credential: its owner's alone on disk, where the store has such a notion.
      if (store.writePrivate !== undefined) await store.writePrivate(file, info || "");
      else await store.write(file, info || "");
      return true;
    } catch (error: unknown) {
      // What failed to be saved is never said: it is the token.
      console.error("Error saving to file ", file, ": ", error);
      return false;
    }
  }

  /**
   * Loads the authentication token from storage.
   * @returns A Promise that resolves when the token is loaded.
   */
  private async token_load(): Promise<void> {
    try {
      // A token saved before files were made private is made so when it is next read.
      await this.storageProvider!.private_tighten?.(this.tokenFile);
      this.authToken = await this.storageProvider!.read(this.tokenFile);
    } catch (error: unknown) {
      // A missing token file is the normal logged-out state; any other read
      // failure (permissions, disk) must not silently present as logged-out.
      const code: string | undefined = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        const msg: string = error instanceof Error ? error.message : String(error);
        errorStack.stack_push("warning", `Could not read auth token file ${this.tokenFile}: ${msg}`);
      }
      this.authToken = null;
    }
  }
}

/**
 * Global instance of ChRISConnection, a stable singleton.
 *
 * Never reassigned: ESM consumers snapshot named imports of this CJS
 * module, so replacing the instance would leave them holding a stale,
 * uninitialized object. `chrisConnection_init` initializes it in place.
 */
export const chrisConnection: ChRISConnection = new ChRISConnection();

/**
 * Initializes the global ChRISConnection instance in place.
 * @param storageProvider - The storage provider to use for the connection.
 */
export async function chrisConnection_init(storageProvider: IStorageProvider): Promise<ChRISConnection> {
  await config_init(storageProvider); // This sets the global connectionConfig
  chrisConnection.init(connectionConfig, storageProvider);
  chrisIO.storageProvider_set(storageProvider);
  return chrisConnection;
}
