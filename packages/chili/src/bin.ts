#!/usr/bin/env node
/**
 * @file chili's command: the only place chili runs as a program.
 *
 * Run at a person's own terminal, the docker chili starts (for `plugins add` of an image) is theirs, so this
 * process trusts it. Nothing else does: importing chili (as brasa does, delegating a line to it inside an engine
 * that someone attends from elsewhere) runs none of this, and an engine trusts no docker of its own.
 *
 * Key components:
 * - the trust of this process's docker, and the run of the line.
 *
 * Typical usage:
 * ```sh
 * chili plugins add fnndsc/pl-x:1
 * ```
 *
 * Dependencies: `@fnndsc/salsa` (`hostDocker_trust`), chili's command line (`chiliCli_main`).
 *
 * @module
 */

import { hostDocker_trust } from "@fnndsc/salsa";

import { chiliCli_fail, chiliCli_main } from "./index.js";

hostDocker_trust();
chiliCli_main(process.argv.slice(2)).catch(chiliCli_fail);
