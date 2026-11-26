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

import { identityElevatedClient_get, identityElevated_run, identityEpoch_raise, identityName_spell } from "./identityEpoch.js";
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

/** What became of a login's answer when its turn came. */
interface LoginAnswer {
  /** A later login, logout or move of context had been asked for: the answer was not acted on. */
  superseded: boolean;
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
  /** Counts every change of who is connected: a read of a saved token notes it, and is not taken if it has moved. */
  private credentials: number = 0;
  /** Counts every login, logout and move of context as it is asked for: an answer that comes back after a later one was asked is not acted on. */
  private asked: number = 0;
  /** Whether the saved token file is known to be the named identity's: false after a transition that failed part way, until someone signs in. */
  private saved: boolean = true;
  /** The awaited part of a change of identity that is under way, or null. */
  private transition: Promise<void> | null = null;
  private _config?: ConnectionConfig; // Renamed backing field
  private storageProvider?: IStorageProvider; // Made optional

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
    // Its place in the order is taken now, as it is asked for and before anything is awaited. Whoever is
    // connected stays readable while CUBE is asked; if a later login or logout is asked before this one's
    // turn comes, this one's answer (a token or a refusal) is dropped.
    const mine: number = this.asked_take();

    // Ensure configuration is initialized before use
    if (this.storageProvider) {
      await config_init(this.storageProvider);
      this._config = connectionConfig;
    }

    const authUrl: string = url + "auth-token/";
    console.log(`Connecting to ${url} with user ${user}`);
    const answer: LoginAnswer = { superseded: false };
    try {
      // Nothing of the connection is changed until CUBE has answered: while the password is being
      // exchanged, and if it is refused, whoever was connected is still wholly connected (their user, their
      // CUBE, their token and their client together).
      const token: string | null = await adapterAuthToken_get(authUrl, user, password);
      if (!token) {
        console.log("Failed to receive auth token");
        return null;
      }
      // The new identity is published in one step, with nothing awaited inside it: there is no moment at
      // which the user is the new one and the client the old. It is published in its turn among the
      // changes of identity under way (a logout asked for meanwhile comes after it, and ends it), and what
      // it writes to disk is written before the next change begins.
      await this.transition_run(async (): Promise<void> => {
        if (mine !== this.asked) {
          answer.superseded = true;
          return;
        }
        this.identity_publish(user, url, token);
        this.saved = true;
        await this._config!.context_set(user, url);
        this.tokenFile = this._config!.tokenFilepath;
        const saved: boolean = await this.token_saveToFile(this.tokenFile, token);
        // Said only when it is so: a token that could not be saved privately is held for this session and not on disk.
        console.log(saved ? "Auth token saved successfully" : "Auth token held for this session; it was not saved");
        console.log("ChRIS URL saved successfully");
      });
      if (answer.superseded) {
        console.log(`The login of ${user} was answered after a later login or logout was asked for; it was not acted on`);
        return null;
      }
      return token;
    } catch (error: unknown) {
      // The real cause, said as what it is: only CUBE's refusal blames the
      // credentials; an untrusted certificate or an unreachable host says so (#965).
      const failure: LoginFailure = await loginFailure_diagnose(error, authUrl, this.loginProbe);
      // A refusal of a login that a later one has since replaced is nobody's news: it ends nothing.
      if (mine !== this.asked) return null;
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
    const mine: number = this.asked_take();
    if (this.storageProvider) {
      await config_init(this.storageProvider);
      this._config = connectionConfig;
    }
    const client: Client = client_create(url, token);
    const answer: LoginAnswer = { superseded: false };
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
    // Published in one step, with the client the token was proved for (its folder lookups remembered, as
    // client_get makes them).
    await this.transition_run(async (): Promise<void> => {
      if (mine !== this.asked) {
        answer.superseded = true;
        return;
      }
      this.identity_publish(user, url, token, folderLookup_memoize(client));
      this.saved = true;
      await this._config!.context_set(user, url);
      this.tokenFile = this._config!.tokenFilepath;
      await this.token_saveToFile(this.tokenFile, token);
    });
    if (answer.superseded) return { connected: false, reason: `the login of ${user} was answered after a later login or logout was asked for; it was not acted on` };
    return { connected: true };
  }

  /**
   * Sets the ChRIS context based on a context string (e.g., user@url?folder=...). 
   * @param context - The context string.
   * @returns A Promise resolving to true on success, false otherwise.
   */
  async context_set(context: string): Promise<boolean> {
    context = contextString_check(context);
    // What had been asked when this was: a login or logout asked while the context is being read comes
    // after it, and a move of identity it names is then not made.
    const entered: number = this.asked;
    const parsedContext: SingleContext = await chrisContextURL_parse(context);

    if (errorStack.messagesOfType_has('error')) {
      const error = errorStack.stack_pop();
      console.error(chalk.red('Context error:', error?.message));
      // Clear any remaining errors to prevent them from affecting subsequent operations
      errorStack.type_clear('error');
      return false;
    }

    let status: boolean = true;

    if ((parsedContext.user || parsedContext.URL) && entered === this.asked) {
      this.asked_take();
      await this.transition_run(async (): Promise<void> => {
        // Who the context names is compared with who is connected when this change's turn comes, not when
        // it was asked for: a login that finished in between is what it is compared with.
        const user: string | null = parsedContext.user || this.user;
        const url: string | null = parsedContext.URL || this.chrisURL;
        // The same user on the same CUBE named again is no change of identity, and empties nothing.
        const changed: boolean = `${user ?? ''}\n${url ?? ''}` !== `${this.user ?? ''}\n${this.chrisURL ?? ''}`;
        // Another user or another CUBE: from this moment nobody is connected as the one before, and until
        // the new one's token has been read nobody is connected at all. (Nothing is awaited before this.)
        // The change is made known once, below, when it is known who is connected after it.
        if (changed) this.identity_publish(user, url, null, null, false);
        try {
          if (parsedContext.user) {
            status = status && (await chrisContext.current_set(Context.ChRISuser, parsedContext.user));
            await this._config!.context_set(parsedContext.user, parsedContext.URL || '');
          }
          if (parsedContext.URL) {
            status = status && (await chrisContext.current_set(Context.ChRISURL, parsedContext.URL));
            await this._config!.context_set(this.user || "", parsedContext.URL);
          }
          // The client for who the context now names, from their own saved token; and, now that it is known
          // whether they have one, who is connected is said by name.
          this.saved = true;
          await this.client_rebuild();
        } catch (error: unknown) {
          // The fields have moved and the write of it failed part way: nobody's client or token is kept
          // from before, so what is held is one coherent thing (the named context, not signed in).
          // And the saved token is not read until someone signs in: the file still named may be the one
          // before's.
          if (changed) {
            this.client = null;
            this.authToken = null;
            this.saved = false;
          }
          throw error;
        } finally {
          // The change is said whether or not the write of it went through: the caches were the one
          // before's either way.
          if (changed) identityEpoch_raise(this.authToken !== null ? identityName_spell(this.user ?? '', this.chrisURL ?? '') : null);
        }
      });
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

    return status;
  }

  /**
   * Retrieves the authentication token.
   * @param forceLoad - If true, forces loading the token from storage.
   * @returns A Promise resolving to the authentication token or null.
   */
  async authToken_get(forceLoad?: boolean): Promise<string | null> {
    await this.transition_wait();
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
      // Read for who is connected now: if that changes before the read comes back, what was read is of the
      // context as it was, and is not put in place of the new one's.
      const began: number = this.credentials;
      const loaded: string | null = await this._config.chrisURL_load();
      if (began === this.credentials && !this.chrisURL) this.chrisURL = loaded;
    }
    return this.chrisURL;
  }

  /**
   * Refreshes the ChRIS API client with current token and URL.
   * @returns A Promise resolving to the refreshed Client instance or null.
   */
  async client_refresh(): Promise<Client | null> {
    await this.transition_wait();
    return this.client_rebuild();
  }

  /**
   * Makes the client again from the token saved for who the context names.
   * The work of {@link client_refresh}, without waiting for a change of
   * identity to finish: it is what such a change itself calls.
   *
   * @returns The client, or null when no token is saved for them.
   */
  private async client_rebuild(): Promise<Client | null> {
    const began: number = this.credentials;
    this.tokenFile = this._config!.tokenFilepath;
    if (!this.chrisURL) {
      const loaded: string | null = this._config ? await this._config.chrisURL_load() : null;
      if (began !== this.credentials) return this.client;
      if (!this.chrisURL) this.chrisURL = loaded;
    }
    await this.token_load();
    // Someone logged in or out while the token was being read: the client is theirs to make.
    if (began !== this.credentials) return this.client;
    // A client for who the context now names, or none: one made for whoever was named before is never kept.
    this.client = this.chrisURL && this.authToken ? folderLookup_memoize(client_create(this.chrisURL, this.authToken)) : null;
    return this.client;
  }

  /**
   * Retrieves the ChRIS API client instance.
   * @returns A Promise resolving to the Client instance or null.
   */
  async client_get(): Promise<Client | null> {
    // Work being done as another user (a `sudo`) has that user's client for its own length.
    const elevatedClient: object | null = identityElevatedClient_get();
    if (elevatedClient !== null) return elevatedClient as Client;
    // A login, a logout or a change of context that is under way is waited for: nobody is handed a client
    // from the middle of one.
    await this.transition_wait();

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
    // Run as that user for the length of the operation: given their client, and marked so that the
    // session's caches are neither read nor filled by it.
    return await identityElevated_run(elevatedClient, operation);
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
    this.asked_take();
    // Nobody is connected from this moment: the token and the client that carries it go together, a read
    // of the saved token that is under way is not taken when it comes back, and what is cached of who was
    // connected is emptied.
    await this.transition_run(async (): Promise<void> => {
      // In its turn: a login still writing its token finishes first, and this then ends it. The file
      // removed is the one that is current when this turn comes.
      this.identity_publish(this.user, this.chrisURL, null);
      try {
        await this.storageProvider!.remove(this.tokenFile);
        console.log("Logged out successfully");
      } catch (error: unknown) {
        // The token could not be removed: it is still on disk, and is not read back. Logged out stays
        // logged out until someone signs in.
        this.saved = false;
        console.error("Error during logout:", error);
      }
    });
  }

  /**
   * Takes the next place in the order of logins, logouts and moves of
   * context, as one is asked for.
   *
   * @returns The place taken: an answer that comes back when it is no longer the latest is not acted on.
   */
  private asked_take(): number {
    this.asked += 1;
    return this.asked;
  }

  /**
   * Publishes who is connected, in one step with nothing awaited inside
   * it: the user, the CUBE, the token and the client change together, a
   * read of a saved token begun before this moment is not taken when it
   * comes back, and the change of identity is made known.
   *
   * @param user - The user now connected, or whoever the context names.
   * @param url - Their CUBE.
   * @param token - Their token, or null when nobody is connected.
   * @param client - A client already made for that token, when there is one.
   * @param announce - False when the caller makes the change known itself, once it knows who is connected after it.
   */
  private identity_publish(user: string | null, url: string | null, token: string | null, client: Client | null = null, announce: boolean = true): void {
    this.user = user;
    this.chrisURL = url;
    this.authToken = token;
    this.client = client;
    this.credentials += 1;
    // Named when someone is connected (`user@url`, the name their checkpoints are kept under); null when nobody is.
    if (announce) identityEpoch_raise(token !== null && user !== null && url !== null ? identityName_spell(user, url) : null);
  }

  /**
   * Runs a change of identity: its publication and what it writes to and
   * reads from disk. Changes run one at a time, in the order they were
   * asked for, and {@link client_get} and {@link authToken_get} wait for
   * all of them.
   *
   * @param work - The change.
   */
  private async transition_run(work: () => Promise<void>): Promise<void> {
    // One at a time, in the order asked: a change begins when the one before it has finished everything
    // it does, what it writes to disk included.
    const before: Promise<void> = this.transition ?? Promise.resolve();
    const run: Promise<void> = before.then(work);
    const held: Promise<void> = run.then((): void => undefined, (): void => undefined).then((): void => {
      if (this.transition === held) this.transition = null;
    });
    this.transition = held;
    await run;
  }

  /** Waits for a change of identity that is under way to finish. */
  private async transition_wait(): Promise<void> {
    while (this.transition !== null) await this.transition;
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
    // Whose token is being read: if someone logs in or out before the read comes back, what was read is
    // not theirs, and is not taken.
    const began: number = this.credentials;
    // After a move of context or a logout that failed part way, the file named may hold a token that is
    // not the named identity's, or one that was to have been removed: it is not read.
    if (!this.saved) return;
    let read: string | null = null;
    try {
      // A token saved before files were made private is made so when it is next read.
      await this.storageProvider!.private_tighten?.(this.tokenFile);
      read = await this.storageProvider!.read(this.tokenFile);
    } catch (error: unknown) {
      // A missing token file is the normal logged-out state; any other read
      // failure (permissions, disk) must not silently present as logged-out.
      const code: string | undefined = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        const msg: string = error instanceof Error ? error.message : String(error);
        errorStack.stack_push("warning", `Could not read auth token file ${this.tokenFile}: ${msg}`);
      }
      read = null;
    }
    if (began !== this.credentials) return;
    const lost: boolean = this.authToken !== null && read === null;
    this.authToken = read;
    // The token that was held is gone from disk: whoever it was is no longer connected, though the user
    // and the CUBE named are the same. Their client goes, and what is cached of them is emptied.
    if (lost) {
      this.client = null;
      this.credentials += 1;
      identityEpoch_raise(null);
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
