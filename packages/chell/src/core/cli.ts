/**
 * @file CLI Parser
 *
 * Extracts the logic for parsing command line arguments for `chell`.
 * This allows testing the argument parsing logic without side effects.
 *
 * @module
 */
import { authArgs_parse, type AuthAsk } from '../remote/auth.js';
import { doorDefault_read } from '../remote/doorFile.js';
import { Command, type Help } from 'commander';
import { existsSync } from 'fs';
import chalk from 'chalk';

/**
 * Parsed chell CLI configuration.
 */
export interface ChellCLIConfig {
  mode: 'interactive' | 'connect' | 'help' | 'version' | 'info' | 'execute' | 'script' | 'daemon' | 'remote' | 'auth';
  /** `chell auth …`: the verb and its words, parsed by the auth module. */
  auth?: AuthAsk;
  physicalFS?: boolean;
  prefetchPlugins?: boolean;
  prefetchFeeds?: boolean;
  prefetchPublicFeeds?: boolean;
  prefetchJobs?: boolean;
  asciiBoot?: boolean;
  showLogo?: boolean;
  commandToExecute?: string;
  scriptFile?: string;
  stopOnError?: boolean;
  connectConfig?: {
    user?: string;
    password?: string;
    url?: string;
  };
  /**
   * An explicit daemon address, bypassing berth discovery. Berths are files in
   * a host's own runtime directory, so a surface on another machine has none
   * to read; this is how it attaches instead.
   */
  attach?: string;
  /** The attach token, when the {@link attach} URL does not carry one. */
  attachToken?: string;
  /**
   * `--remote <user>@<where>`: the target exactly as typed, so a berth keyed
   * by a cloud identity (`rudolph@fnndsc`, or two `@` when the user is an
   * e-mail address) is found by its own string before any URL reading.
   */
  remoteTarget?: string;
  /**
   * `--door <url>`: come through a porter — log in there with a password,
   * follow the boot, attach to the session it mounts. No token reaches the
   * terminal; the door's cookie does.
   */
  door?: string;
  /** `--host-control [tiers]` as typed (true for bare). */
  hostControl?: string | boolean;
  /** `--expose-host-control`. */
  exposeHostControl?: boolean;
  /**
   * `--auth-token-stdin`: the CUBE token comes in on stdin, one line, from a
   * front that authenticated the operator itself. It rides beside the
   * `<user>@<url>` target rather than inside it, so a target-less invocation
   * can still be refused by name.
   */
  authTokenStdin?: boolean;
  /**
   * `--saved-token`: log in with the token this identity saved last time, and
   * refuse (rather than fall back to offline) when there is none or the
   * server will not have it — how a porter restarts a session without the
   * operator's password.
   */
  savedToken?: boolean;
  output?: string; // For help/version text
}

/**
 * Options accepted by the chell CLI action handler.
 */
export interface CliActionOptions {
  user?: string;
  password?: string;
  /** `--no-door`: never route through the default door. (commander: `door: false` when given; see `noDoor`.) */
  noDoor?: boolean;
  command?: string;
  file?: string;
  e?: boolean;
  physicalFS?: boolean;
  prefetchFeeds?: boolean;
  prefetchPublicFeeds?: boolean;
  prefetchPlugins?: boolean;
  prefetchJobs?: boolean;
  asciiBoot?: boolean;
  logo?: boolean;
  daemon?: boolean;
  hostControl?: string | boolean;
  exposeHostControl?: boolean;
  remote?: boolean;
  attach?: string;
  token?: string;
  door?: string;
  authTokenStdin?: boolean;
  savedToken?: boolean;
  info?: boolean;
}

/** The environment variable a daemon hands its attach token in (calypso's `ATTACH_TOKEN_ENV`). */
export const ATTACH_TOKEN_ENV: string = 'CHELL_ATTACH_TOKEN';

/**
 * Takes the attach token a daemon handed over in the environment, and
 * removes it from there: read once, then gone, so a program this shell
 * starts (a `!` line, an editor, a pipe segment) does not inherit it.
 *
 * @param env - The environment.
 * @returns The token, or undefined when none was handed over.
 */
export function attachTokenEnv_take(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const handed: string | undefined = env[ATTACH_TOKEN_ENV];
  delete env[ATTACH_TOKEN_ENV];
  return handed !== undefined && handed !== '' ? handed : undefined;
}

/**
 * Builds a {@link ChellCLIConfig} from the parsed target/options, determining
 * the run mode (script/execute/connect/interactive) and applying startup
 * preference toggles.
 *
 * @param target - The positional target argument (user@url, url, or script path).
 * @param options - The parsed CLI options.
 * @param fileExists - Predicate testing whether a path exists (for script auto-detect).
 * @param defaultDoor - Reads the default door, when one is set.
 * @param handed - The attach token a daemon handed over in the environment, already taken out of it (`cli_parse` does that, once, on every path); used only by a shell that is attaching, and only when none was typed.
 * @returns The resolved configuration.
 */
export function cliConfig_parse(
  target: string | undefined,
  options: CliActionOptions,
  fileExists: (path: string) => boolean,
  defaultDoor: () => string | null = doorDefault_read,
  handed?: string,
): ChellCLIConfig {
  let user: string | undefined = options.user;
  let url: string | undefined = target;
  const password: string | undefined = options.password;
  let connectConfig: { user?: string; password?: string; url?: string } | undefined;

  if (url && url.includes('@')) {
    const parts: string[] = url.split('@');
    user = parts[0];
    url = parts[1];
  }

  if (url) {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url;
    }
    connectConfig = { user, password, url };
  }

  let config: ChellCLIConfig;
  if (options.remote) {
    // A remote surface attaches to a daemon; it needs no local engine,
    // connection, or CUBE credentials — but a `<user>@<url>` target names which
    // identity's daemon to attach to when several run on this machine.
    config = { mode: 'remote', connectConfig };
    if (target !== undefined && target.includes('@')) {
      config.remoteTarget = target;
    } else if (user !== undefined && url !== undefined) {
      config.remoteTarget = `${user}@${url}`;
    }
    // Berth discovery reads this machine's runtime directory, so it cannot see
    // a daemon on another host. An explicit address is how a surface elsewhere
    // attaches, and it bypasses discovery entirely.
    if (options.attach !== undefined) {
      config.attach = options.attach;
    }
    // The attach token comes on the command line when a person types it, and in the environment when a
    // daemon starts this shell: a daemon never puts it on a command line, which every user of the host can
    // list.
    if (options.token !== undefined) {
      config.attachToken = options.token;
    } else if (handed !== undefined) {
      config.attachToken = handed;
    }
    // A door takes a name and a password rather than an address and a token;
    // `-u` and `-p` reach it without a `<user>@<url>` target, which names a
    // CUBE the door already knows.
    if (options.door !== undefined) {
      config.door = options.door;
      config.connectConfig = { ...(config.connectConfig ?? {}), ...(options.user !== undefined ? { user: options.user } : {}), ...(options.password !== undefined ? { password: options.password } : {}) };
    }
    if (options.command !== undefined) {
      config.commandToExecute = options.command;
    }
    if (options.e) config.stopOnError = true;
  } else if (options.daemon) {
    config = {
      mode: 'daemon',
      physicalFS: options.physicalFS,
      connectConfig,
      ...(options.hostControl !== undefined ? { hostControl: options.hostControl } : {}),
      ...(options.exposeHostControl ? { exposeHostControl: true } : {}),
    };
  } else if (options.file) {
    config = { mode: 'script', scriptFile: options.file, stopOnError: options.e || false, physicalFS: options.physicalFS, connectConfig };
  } else if (options.command) {
    config = { mode: 'execute', commandToExecute: options.command, stopOnError: options.e || false, physicalFS: options.physicalFS, connectConfig };
  } else if (target && fileExists(target)) {
    // Auto-detect script file: if target exists as a file, treat as script
    config = { mode: 'script', scriptFile: target, stopOnError: options.e || false, physicalFS: options.physicalFS };
  } else if (connectConfig) {
    config = { mode: 'connect', physicalFS: options.physicalFS, connectConfig };
  } else {
    config = { mode: 'interactive', physicalFS: options.physicalFS };
  }

  // A default door (`chell auth login`) is the way in when nothing else was
  // said: a bare `chell` or a `chell -c "…"` with no target goes through it,
  // the way `gh` reaches GitHub with no flags once logged in. `--no-door`
  // asks for the local chell anyway; a target (`user@url`) names a CUBE
  // directly and is never routed through a door.
  if ((config.mode === 'interactive' || config.mode === 'execute') && connectConfig === undefined && !options.noDoor) {
    const door: string | null = defaultDoor();
    if (door !== null) {
      config = {
        mode: 'remote',
        door,
        physicalFS: options.physicalFS,
        ...(config.commandToExecute !== undefined ? { commandToExecute: config.commandToExecute } : {}),
        ...(config.stopOnError ? { stopOnError: true } : {}),
        ...(options.user !== undefined || options.password !== undefined
          ? { connectConfig: { ...(options.user !== undefined ? { user: options.user } : {}), ...(options.password !== undefined ? { password: options.password } : {}) } }
          : {}),
      };
    }
  }
  if (options.authTokenStdin) {
    config.authTokenStdin = true;
  }
  if (options.savedToken) {
    config.savedToken = true;
  }

  // Apply startup preference toggles when provided
  if (typeof options.prefetchFeeds === 'boolean') config.prefetchFeeds = options.prefetchFeeds;
  if (typeof options.prefetchPublicFeeds === 'boolean') config.prefetchPublicFeeds = options.prefetchPublicFeeds;
  if (typeof options.prefetchPlugins === 'boolean') config.prefetchPlugins = options.prefetchPlugins;
  if (typeof options.prefetchJobs === 'boolean') config.prefetchJobs = options.prefetchJobs;
  if (typeof options.asciiBoot === 'boolean') config.asciiBoot = options.asciiBoot;
  if (typeof options.logo === 'boolean') config.showLogo = options.logo;

  return config;
}

/**
 * Custom man-page-style help formatter for the chell program.
 *
 * @param cmd - The command being rendered.
 * @param helper - Commander's help helper.
 * @returns The formatted help string.
 */
function chellHelp_format(cmd: Command, helper: Help): string {
  const termWidth: number = helper.padWidth(cmd, helper);
  const helpWidth: number = helper.helpWidth || 80;
  const itemIndentWidth: number = 2;
  const itemSeparatorWidth: number = 2; // between term and description

  const item_format = (term: string, description: string): string => {
    if (description) {
      const fullText: string = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
      return helper.wrap(fullText, helpWidth - itemIndentWidth, termWidth + itemSeparatorWidth);
    }
    return term;
  };

  const list_format = (textArray: string[]): string =>
    textArray.join('\n').replace(/^/gm, ' '.repeat(itemIndentWidth));

  // Usage
  let output: string[] = [`${chalk.bold.cyan('USAGE')}\n  ${helper.commandUsage(cmd)}`, ''];

  // Description
  const commandDescription: string = helper.commandDescription(cmd);
  if (commandDescription.length > 0) {
    output = output.concat(['  ' + helper.wrap(commandDescription, helpWidth - 2, 0).replace(/\n/g, '\n  '), '']);
  }

  // Arguments
  const argumentList: string[] = helper.visibleArguments(cmd).map((argument) =>
    item_format(helper.argumentTerm(argument), helper.argumentDescription(argument)),
  );
  if (argumentList.length > 0) {
    output = output.concat([chalk.bold.cyan('ARGUMENTS'), list_format(argumentList), '']);
  }

  // Options
  const optionList: string[] = helper.visibleOptions(cmd).map((option) =>
    item_format(helper.optionTerm(option), helper.optionDescription(option)),
  );
  if (optionList.length > 0) {
    output = output.concat([chalk.bold.cyan('OPTIONS'), list_format(optionList), '']);
  }

  return output.join('\n');
}

/**
 * Builds the configured commander program (name, version, help text, and
 * options) for chell, without an action handler attached.
 *
 * @param version - The package version string.
 * @returns The configured commander Command.
 */
function cliProgram_build(version: string): Command {
  const program: Command = new Command();
  program
    .name('chell')
    .version(version)
    .description('ChRIS Interactive Shell (ChELL) - A powerful, terminal-based virtual file system (VFS) and interactive REPL for ChRIS.')
    .addHelpText('before', `
${chalk.bold.cyan('NAME')}
    ${chalk.bold('chell')} - ChRIS Interactive Shell (ChELL Executes Layered Logic)

${chalk.bold.cyan('DESCRIPTION')}
    ${chalk.bold('ChELL')} is a terminal-based interface and Virtual File System (VFS)
    router for the ChRIS medical image processing platform. It bridges the gap
    between complex web APIs and terminal muscle-memory.

    It maps remote ChRIS CUBE resources to an intuitive local folder experience:
      - Feeds, pipelines, and files are structured as navigable directories.
      - Registered CUBE plugins are mapped as executable binaries inside ${chalk.yellow('/bin')}.
      - Standard utilities (${chalk.green('cd')}, ${chalk.green('ls')}, ${chalk.green('pwd')}, ${chalk.green('cat')}) run directly on remote storage.

    Whether navigating data or running pipelines, ChELL leverages your current
    working directory as execution context, letting you run containerized medical
    image analyses using command-line muscle-memory.
      `)
    .argument('[target]', 'Target CUBE (user@url or url)')
    .option('-u, --user <user>', 'Username')
    .option('-p, --password <password>', 'Password')
    .option('-c, --command <command>', 'Execute command(s) and exit (use ; to separate multiple commands)')
    .option('-f, --file <path>', 'Execute commands from script file')
    .option('-e', 'Stop a -c batch at its first error (like bash set -e). A script always stops at its first refused line')
    .option('--physicalFS', 'Use physical filesystem paths (skip logical-to-physical mapping)')
    .option('--prefetch-feeds', 'Prefetch user feeds at startup (interactive mode)')
    .option('--no-prefetch-feeds', 'Disable feed prefetch at startup')
    .option('--prefetch-public-feeds', 'Prefetch public feeds at startup (interactive mode)')
    .option('--no-prefetch-plugins', 'Skip plugin cache prefetch at startup')
    .option('--no-prefetch-jobs', 'Skip /proc/jobs job cache prefetch at startup')
    .option('--ascii-boot', 'Force ASCII-only boot UI (no box-drawing characters)')
    .option('--no-logo', 'Hide the ChRIS logo on startup (interactive mode)')
    .option('--daemon', 'Run calypso here: host this engine as a session other surfaces attach to (same as the `calypso` command)')
    .option('--host-control [tiers]', 'With --daemon: calypso acts on its own host — `!` runs here, pipes run here, upload/download reach this disk (tiers: shell,files,pipes,tasks; bare = shell,files,pipes; env CALYPSO_HOST_CONTROL)')
    .option('--expose-host-control', 'With --host-control and a non-loopback CALYPSO_BIND: yes, hand a shell on this host to anyone holding the attach URL')
    .option('--remote', 'Attach to a running calypso as a remote surface')
    .option('--attach <url>', 'Address of calypso on another machine; accepts the URL it prints, token and all')
    .option('--token <token>', 'Attach token, when the --attach URL does not carry one')
    .option('--door <url>', 'With --remote: come through a porter — log in there (a door token from chell auth login, -u/-p, or be asked), and attach to the session it mounts')
    .option('--no-door', 'The local chell, even when chell auth login has set a default door')
    .option('--auth-token-stdin', 'Log in with a CUBE auth token read from stdin (one line) instead of a password; needs <user>@<url>')
    .option('--saved-token', 'Log in with the token <user>@<url> saved last time, refusing if there is none or it is refused (no offline fallback)')
    .option('--info', 'Show a detailed table of the stack packages, roles, and versions, then exit')
    .addHelpText('after', `
${chalk.bold.cyan('AUTH')}
  ${chalk.bold.green('chell auth login')}     log in at a porter once (a browser code, a password, or a pasted token) and keep a door token
  ${chalk.bold.green('chell auth status')}    who you are at the door and how long the token lives
  ${chalk.bold.green('chell auth logout')}    revoke the token at the door and remove its file
  ${chalk.bold.green('chell auth token')}     mint a token to carry to another machine (--name <what it is for>)
  ${chalk.bold.green('chell auth tokens')}    this identity's tokens at the door
`)
    .addHelpText('after', `
${chalk.bold.cyan('INTERACTIVE COMMANDS')}
  ${chalk.bold.green('connect')}     Connect to a ChRIS CUBE
  ${chalk.bold.green('logout')}      Log out from the current CUBE session
  ${chalk.bold.green('cd')}          Change the current virtual directory
  ${chalk.bold.green('ls')}          List virtual directory contents
  ${chalk.bold.green('pwd')}         Print the current virtual working directory
  ${chalk.bold.green('cat')}         Display file contents
  ${chalk.bold.green('exit')}        Exit the interactive shell
  ${chalk.bold.yellow('<other>')}     Any unrecognized command is passed directly to the chili CLI

${chalk.bold.cyan('SHELL FEATURES')}
  ${chalk.bold('Pipes')}              Chain command stdout: ${chalk.dim('cat file.txt | wc -l')}
  ${chalk.bold('Output Redirection')} Write/append to a file on the session's host disk: ${chalk.dim('ls -lh > output.txt')} ${chalk.dim('(under a daemon: --host-control=files)')}
  ${chalk.bold('Semicolons')}         Run sequentially: ${chalk.dim('cd /tmp; ls; pwd')}
  ${chalk.bold('Shell Escape')}       Run host OS commands inside the REPL with ${chalk.bold.green('!')} prefix

${chalk.bold.cyan('AUTOMATION & SCRIPTING')}
  ${chalk.bold('Shebang Support')}     Prepend ${chalk.yellow('#!/usr/bin/env chell')} to make scripts executable
  ${chalk.bold('Comments')}            Lines beginning with ${chalk.bold('#')} are ignored
  ${chalk.bold('Error Handling')}      A script stops at its first refused line; ${chalk.bold.green('-e')} stops a -c batch at its first failure

${chalk.bold.cyan('EXAMPLES')}
  ${chalk.bold('chell')} ${chalk.bold.green('-c')} ${chalk.yellow('"ls /PIPELINES"')}                           # Execute single command and exit
  ${chalk.bold('chell')} ${chalk.bold.green('-c')} ${chalk.yellow('"cd /PIPELINES; ls; cat main.yml"')}     # Sequential CLI command pipeline
  ${chalk.bold('chell')} ${chalk.yellow('script.chell')}                                 # Run script file (auto-detect)
  ${chalk.bold('chell')} ${chalk.bold.green('-e')} ${chalk.yellow('script.chell')}                               # Run script file (it always stops on first error)
  ${chalk.bold('./script.chell')}                                     # Execute direct script via shebang
      `)
    .configureHelp({ formatHelp: chellHelp_format });
  return program;
}

/**
 * Parses command line arguments and extracts configuration for the Chell interactive shell.
 *
 * @param argv - The command line arguments (typically process.argv).
 * @param version - The version report shown by `--version`.
 * @param info - The detailed stack table shown by `--info`.
 * @param env - The environment, from which a daemon's attach token is taken, and removed, before anything else.
 * @returns A Promise resolving to a ChellCLIConfig containing the parsed parameters.
 */
export function cli_parse(argv: string[], version: string, info: string = '', env: NodeJS.ProcessEnv = process.env): Promise<ChellCLIConfig> {
  // First of all, on every path out of here (`auth`, `--info`, help, a version, a line that does not
  // parse, as much as a shell that attaches): a daemon's attach token is taken out of the environment, so
  // nothing this process goes on to start inherits it. Only a shell that is attaching is given it.
  const handed: string | undefined = attachTokenEnv_take(env);
  // `chell auth …` is a subcommand with words of its own, read before the
  // program's own parser would take `auth` for a target.
  // A wrapper may put `--remote --door <url>` in front of every call (titan's
  // did, and `chell auth login` became a plain door login); those words are
  // stepped over, and a door given there is the auth verb's door.
  let at: number = 2;
  let leadDoor: string | undefined;
  while (argv[at] === '--remote' || (argv[at] === '--door' && argv[at + 1] !== undefined)) {
    if (argv[at] === '--door') { leadDoor = argv[at + 1]; at += 2; } else { at += 1; }
  }
  if (argv[at] === 'auth') {
    const asked: AuthAsk | { refusal: string } = authArgs_parse(argv.slice(at + 1));
    if ('refusal' in asked) return Promise.resolve({ mode: 'help', output: asked.refusal });
    return Promise.resolve({ mode: 'auth', auth: asked.door === undefined && leadDoor !== undefined ? { ...asked, door: leadDoor } : asked });
  }
  return new Promise((resolve) => {
    const program: Command = cliProgram_build(version);
    let config: ChellCLIConfig = { mode: 'interactive' };
    let capturedOutput: string = '';

    program
      .action((target: string | undefined, options: CliActionOptions) => {
        // commander reads `--no-door` as `door: false`; a door URL and the
        // refusal of one are two words here.
        const doorRaw: unknown = (options as { door?: unknown }).door;
        const normalised: CliActionOptions = doorRaw === false
          ? { ...options, door: undefined, noDoor: true }
          : doorRaw === true ? { ...options, door: undefined } : options;
        config = options.info ? { mode: 'info', output: info } : cliConfig_parse(target, normalised, existsSync, doorDefault_read, handed);
      });

    // Capture help/version output instead of writing to stdout
    program.configureOutput({
      writeOut: (str: string) => {
        capturedOutput += str;
        config = { mode: 'help', output: capturedOutput };
      },
      writeErr: (str: string) => {
        capturedOutput += str;
        config = { mode: 'help', output: capturedOutput };
      },
      outputError: (str: string) => {
        capturedOutput += str;
        config = { mode: 'help', output: capturedOutput };
      }
    });
    
    // We need to handle exit events to prevent process.exit() during tests
    program.exitOverride((err: Error & { code?: string }) => {
        if (err.code === 'commander.helpDisplayed') {
            resolve({ mode: 'help', output: capturedOutput || program.helpInformation() });
        } else if (err.code === 'commander.version') {
            resolve({ mode: 'version', output: version });
        } else {
            // For other errors (e.g. missing arg), we might want to reject or return help
            resolve({ mode: 'help', output: err.message });
        }
        // We return a promise that never resolves here to stop execution flow in main? 
        // No, in `cli_parse` we resolve.
        throw err; // Rethrow to be caught by parseAsync catch block
    });

    program.parseAsync(argv)
      .then(() => {
          resolve(config);
      })
      .catch((err: Error & { code?: string }) => {
          // If exitOverride threw, we handled it above mostly?
          // Actually exitOverride throws.
          if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
             resolve(config);
          } else {
             // Real error
             // For now, treat as help/error output
             resolve({ mode: 'help', output: err.message });
          }
      });
  });
}
