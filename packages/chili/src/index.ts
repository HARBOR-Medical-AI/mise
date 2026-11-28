#!/usr/bin/env node
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

import { hostDocker_trust } from "@fnndsc/salsa";
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
 * Bin entry: register shell completion, then run the requested chili command.
 */
async function main(): Promise<void> {
  // chili's own command line runs at a person's own terminal: the docker it starts is theirs. In an engine
  // (brasa delegating a line to chili in its process) this never runs, and no docker is trusted.
  hostDocker_trust();
  commandCompletion_setup();
  await run(process.argv.slice(2));
}

main().catch((error) => {
  chiliErrLog("An error occurred:", error);
  process.exit(1);
});

// Re-export library utilities for consumers that import the package root.
