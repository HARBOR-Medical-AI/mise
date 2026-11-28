/**
 * @file Command-line entry point for the chili (ChILI) CLI.
 *
 * This is a thin wrapper: all command wiring and execution live in {@link run}
 * (./run.js) so the same logic can be driven in-process by a host such as chell
 * without spawning a separate `node` subprocess. This file only adds the
 * bin-only concerns — shell completion and fatal-exit handling.
 *
 * @module
 */

import omelette from "omelette";

import { run } from "./run.js";
import { chiliErrLog, chiliLog } from "./screen/output.js";

/**
 * Sets up shell command completion for the standalone chili CLI using omelette.
 * This is a bin-only concern; in-process hosts provide their own completion.
 */
function commandCompletion_setup(): void {
  const completion: omelette.Instance = omelette(`chili|chili`);
  completion.tree({
    connect: ["--user", "--password"],
    man: {
      doc: [], // We'll populate this later with actual topics
    },
    chefs: ["ls", "mkdir", "touch"],
    plugins: {
      list: ["--page", "--fields", "--search"],
      info: ["<pluginId>"],
      fieldslist: [],
      delete: ["<IDs>", "--search", "--force"],
    },
    feeds: {
      list: ["--page", "--fields", "--search"],
      new: ["--name", "--path"],
      fieldslist: [],
      delete: ["<IDs>", "--search", "--force"],
    },
    inode: {
      "<path>": {
        files: {
          list: ["--page", "--fields", "--search"],
          fieldslist: [],
          delete: ["<IDs>", "--search", "--force"],
          share: ["--force"],
        },
        file: {
          view: ["--type"],
        },
      },
    },
  });

  completion.on("man.doc", ({ reply }) => {
    chiliLog("Autocomplete triggered for man doc command");
    reply([]);
  });

  completion.init();

  if (~process.argv.indexOf("--completion")) {
    completion.setupShellInitFile();
  }
}

/**
 * chili's command line: register shell completion, then run the requested chili command. Importing this module
 * runs nothing; `bin.ts`, chili's command, calls it.
 *
 * @param argv - The words after `chili`.
 *
 * @example
 * ```ts
 * await chiliCli_main(process.argv.slice(2));
 * ```
 */
export async function chiliCli_main(argv: string[]): Promise<void> {
  commandCompletion_setup();
  await run(argv);
}

/**
 * Says a command-line run's failure and ends the process with it.
 *
 * @param error - What the run threw.
 *
 * @example
 * ```ts
 * chiliCli_main(process.argv.slice(2)).catch(chiliCli_fail);
 * ```
 */
export function chiliCli_fail(error: unknown): void {
  chiliErrLog("An error occurred:", error);
  process.exit(1);
}

// Re-export library utilities for consumers that import the package root.
