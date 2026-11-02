# @fnndsc/calypso

## 0.28.3

### Patch Changes

- Updated dependencies [f6790b6]
  - @fnndsc/menu@0.32.0
  - @fnndsc/brasa@0.51.2
  - @fnndsc/cumin@3.29.5

## 0.28.2

### Patch Changes

- Updated dependencies [8fd7226]
- Updated dependencies [ec2d610]
- Updated dependencies [68d09fc]
- Updated dependencies [71f3c63]
  - @fnndsc/brasa@0.51.0

## 0.28.1

### Patch Changes

- f086bc6: A daemon's console runs the chell installed beside it, not whichever chell the path finds first. A stratus session, and the calypso binary, spawned the console from `chell` on the path, so on a host whose path leads to another install the console greeted with "This chell and the calypso daemon are different builds" and a host with no chell on the path had no console at all. Calypso now resolves `@fnndsc/chell` from its own install and runs that entry under its own node; a daemon that passes its own launch (chell's) is unchanged, and the path remains the fallback where no chell is installed beside calypso.
- Updated dependencies [4568c64]
  - @fnndsc/menu@0.31.1

## 0.28.0

### Minor Changes

- 41769da: Each surface keeps its own last answer, so `@3` counts the listing that surface read. A listing read in a browser no longer renumbers the rows a console is about to act on: calypso hands every line its surface as origin, the kernel keeps one answer per origin, and a numbering goes only to the surface whose line listed. A surface that leaves takes its answer with it; one that attaches has listed nothing yet (#1273).
- 0efbb7c: A PULL in ARGUS runs in the background: the console and every other press stay yours while a retrieve goes on. The press sends `pull … &`; the badges follow it as before, each running joblet is a row on the LANE instrument with a STOP that types `kill %N`, the console prints when one starts, ends or waits for an answer, and RESTART names the joblets it would end (#1273).

  A joblet relays its progress, and any model it answers with, to the surface it came from; its task carries its progress. The heartbeat's lane lists the running joblets, calypso answers `GET /joblets` (token-gated), and a porter login that finds a session on older code keeps it, rather than restart it, while joblets run.

- b8bc519: A line ended with `&` runs in the background as a joblet, so a long pull no longer holds the console it was typed in. It is kept at `/proc/joblets/<N>` with its output in its log; its surface hears `[1] … &` when it starts and `[1]+ Done`, `Failed (exit N): …` or `Stopped` when it ends. `joblets` lists them, `fg %1` answers what one waits on and follows it, `kill %1` and `wait %1` stop and follow one. A joblet stands where its line was typed with that line's variables, its own `cd`s and assignments staying inside it, and holds what its line changes in the same lane as every line; one that needs an answer pauses until someone brings it forward (#1273).

  Every session's runner now carries the core's `joblets` source (a runner source may be `ungated`, needing no tier, and words its own end `notice`, sent to the surface in `data.origin`). An ambient `envelope` event may name its `origin`; calypso sends it to that surface while it is attached. A `Surface` may offer `hold(holds)`, which calypso answers from its lane (`hold_take`). `cwdScope_run` takes a start folder, and a `cd` under one stays in it.

- 56debd5: A read runs while another line works: `ls` in a browser comes back while a PACS pull runs in a console. Each command says what it changes of the session, and calypso runs lines side by side unless they change the same piece: a read holds nothing, `cd` holds the working directory, `gather` the cohort, and a command that has not said holds the whole session, so it waits and is waited for as before (#1273).

  Each line keeps its own slot in calypso (its surface, its questions, its STOP) and in the kernel (its cancellation, a played manifest's depth and recorder mute, and the directory it stands in, read once when it first asks), so the per-command hand-over a question used to need (`turn_leave`, `turn_resume`, `turn_abort`) is gone; a STOP names the line it reaches. `tree` and `du` scan a named folder where it stands (chili's `scan_do` takes a `folder`) instead of moving the shared directory there and back.

### Patch Changes

- Updated dependencies [41769da]
- Updated dependencies [0efbb7c]
- Updated dependencies [7a10507]
- Updated dependencies [b8bc519]
- Updated dependencies [56debd5]
  - @fnndsc/brasa@0.50.0
  - @fnndsc/menu@0.31.0
  - @fnndsc/cumin@3.29.3

## 0.27.1

### Patch Changes

- Updated dependencies [e9ea847]
- Updated dependencies [e12598c]
- Updated dependencies [f8b07e0]
- Updated dependencies [26df4e2]
  - @fnndsc/brasa@0.49.0

## 0.27.0

### Minor Changes

- 4bc9d87: The dashboard and every other line keep working while a long build is being followed.

  Following a task (`domain build`, `wait`) steps out of the session's turn between the task's lines, as a question already did, so a pane's reads run meanwhile; STOP still reaches the follow. A line whose browser has closed can now be stopped from any surface. A line typed in one browser never opens on another.

- 02c20bf: Every function name now says what it does: the 462 that put a preposition where the verb goes are renamed (#1227).

  The style guide names a function `<subject>[Qualifier]_<verb>[Adverb]`. Names such as `answerRows_of`, `seriesUID_ofPath`, `options_toParams` and `ask_onPane` put a preposition in the verb's place, which names the result without saying whether the function derives, parses, builds or renders it. They are now `answerRows_derive`, `seriesUID_parse`, `options_convertToParams` and `askOnPane_await`. A preposition may still qualify the verb (`x_readFromCache`) or the object (`askOnPane_await`); it may not start the method.

  `npm run lint:rpn` (`scripts/rpn-prepositions.mjs`) refuses a function, `const` function or underscored method whose method is, or starts with, `of`, `to`, `with`, `from`, `for`, `by`, `as`, `in`, `on` or `at`, and CI runs it. The exported names change with no aliases kept: nothing outside this repository imports them.

### Patch Changes

- Updated dependencies [fd1711f]
- Updated dependencies [4bc9d87]
- Updated dependencies [5602a4f]
- Updated dependencies [c58c3a6]
- Updated dependencies [02c20bf]
- Updated dependencies [55e2041]
  - @fnndsc/menu@0.30.0
  - @fnndsc/brasa@0.48.0
  - @fnndsc/cumin@3.29.0

## 0.26.2

### Patch Changes

- 46bc80d: Zod moves to 4.6.7: zod 3 carries a high-severity advisory with no 3.x fix, which failed every build's audit. The advisory is GHSA-mrhx-c7xc-m3w5, memory exhaustion while validating oversized constrained collections. The wire schemas read as before: `.catch` fallbacks, `.default` values, `.passthrough()` and the recursive DICOM tag parse were checked against zod 4. `dicomTagSchema` is typed `z.ZodType<DicomTag, unknown>`; schemas exported from `@fnndsc/menu` are zod 4 schemas, so code that names zod 3's types against them (`ZodTypeDef`, `SafeParseReturnType`) has to move too. A boundary reason now renders a symbol in a path instead of throwing. salsa's nested lockfile, which only the audit reads, overrides zod until a `@fnndsc/menu` built on zod 4 is published, and is back in step with salsa's `package.json`.
- Updated dependencies [e1d052d]
- Updated dependencies [b4cd618]
- Updated dependencies [6a766d2]
- Updated dependencies [52b9691]
- Updated dependencies [9c9ec38]
- Updated dependencies [05ec948]
- Updated dependencies [d6cdb13]
- Updated dependencies [caff86a]
- Updated dependencies [46bc80d]
  - @fnndsc/brasa@0.47.0
  - @fnndsc/menu@0.29.0
  - @fnndsc/cumin@3.28.6

## 0.26.1

### Patch Changes

- Updated dependencies [f2180c1]
- Updated dependencies [c90b8a2]
- Updated dependencies [243aafa]
- Updated dependencies [0a52833]
  - @fnndsc/brasa@0.46.0

## 0.26.0

### Minor Changes

- 49501d4: A daemon can now be allowed to start jobs that change a cloud and bill, with --host-control tasks; bare and all never grant it. The tier is named on its own because it reaches beyond this host into money. The daemon's surface declares it to the engine, jobs left running by the last launch are picked up again after the surface is installed, and the launch says how many. On a non-loopback bind the guard names spending rather than a shell when `tasks` is the only tier.

### Patch Changes

- 0388f12: A stratus or null session greets cleanly: no red `motd` refusal on attach, and no ChRIS packages in its banner.

  The greeting asks `motd` with its output scoped away and prints only what `motd` answered, so a backend without one says nothing. A remote line's live output now goes to the sink it was sent from, not whichever is active when it arrives. The daemon's banner and attach answer name chili, salsa and cumin only for a ChRIS session (`versionsForBackend_of`).

- Updated dependencies [0388f12]
- Updated dependencies [01fcb59]
- Updated dependencies [49ccdfd]
- Updated dependencies [49501d4]
- Updated dependencies [49501d4]
- Updated dependencies [14f8fc1]
- Updated dependencies [2a5a921]
- Updated dependencies [dcdc6cd]
  - @fnndsc/brasa@0.45.0
  - @fnndsc/menu@0.28.0
  - @fnndsc/cumin@3.28.4

## 0.25.0

### Minor Changes

- 21649d1: A running command can show its surface a typed event, and trek shows its state at every Command: prompt.

  `OutputSink` gains `event_write(kind, data)`, the wire gains the `event` message (daemon to the command's origin surface, live only), and the ARGUS client hands events to its host. bsd-trek's `TrekTerminal` gains `state_show`, called with a deep copy of the whole game state before each command is asked for; the session's `trek` sends it as `games.trek.state`. The recorded C games replay unchanged; a terminal that only prints leaves `state_show` out. This is what a bridge that draws the game reads, instead of the printed scans.

### Patch Changes

- Updated dependencies [f42918a]
- Updated dependencies [21649d1]
  - @fnndsc/brasa@0.44.0
  - @fnndsc/menu@0.27.0
  - @fnndsc/cumin@3.28.2

## 0.24.3

### Patch Changes

- 057ae8e: A pipe ends in wc, head, tail, sort, uniq or cut on every surface, ARGUS's terminal included: they run in the session.

  `find /proc/jobs -plugin pl-dylld | wc -l` failed in ARGUS: `wc` was a host program, and a browser runs none. The six are builtins now, with POSIX's common flags and meanings (`wc -lwcm`, `head`/`tail -n N`, `-N`, `head -n -N`, `tail -n +N`, `sort -rnfu -k N[,M] -t C`, `uniq -cdui`, `cut -f/-c LIST -d C -s`), reading what is piped in or ChRIS files named as operands. A flag they do not take goes to the system program, with the piped text, where the surface runs one, and is refused by name where it does not; `command sort` still asks for the system's. The daemon now says truly whether the acting surface can run a pipe segment (a chell can, a browser cannot, any surface under `--host-control pipes`), so grep and these filters answer in the kernel rather than handing text to a browser that refuses it.

- Updated dependencies [d6337c6]
- Updated dependencies [057ae8e]
  - @fnndsc/cumin@3.28.1
  - @fnndsc/brasa@0.43.0

## 0.24.2

### Patch Changes

- Updated dependencies [20cd854]
  - @fnndsc/cumin@3.28.0
  - @fnndsc/brasa@0.42.0

## 0.24.1

### Patch Changes

- Updated dependencies [e9d9540]
  - @fnndsc/brasa@0.41.0
  - @fnndsc/cumin@3.27.20

## 0.24.0

### Minor Changes

- c1ad144: Full-screen host programs such as vi, top or your own zsh now work in the ARGUS terminal when host control is on. `!cmd` typed there runs in the terminal's own pty, and Ctrl-C reaches it as an interrupt.
- fb6813d: Any running command can now be stopped, with Ctrl-C or the console's new STOP capsule. A host process it started is killed, and a command that does not end when asked is abandoned after three seconds so the session is free again. A chell that disconnects stops its command, and Ctrl-C reaches a host program in the terminal.

### Patch Changes

- Updated dependencies [5dadfdd]
- Updated dependencies [c7acb1b]
- Updated dependencies [fb6813d]
  - @fnndsc/brasa@0.40.0
  - @fnndsc/menu@0.26.0
  - @fnndsc/cumin@3.27.19

## 0.23.1

### Patch Changes

- Updated dependencies [66f1956]
- Updated dependencies [66f1956]
  - @fnndsc/brasa@0.39.0
  - @fnndsc/menu@0.25.0
  - @fnndsc/cumin@3.27.17

## 0.23.0

### Minor Changes

- 90b7688: The ARGUS console is now a terminal by default wherever the daemon offers one; TRANSCRIPT on its drawer goes back. A browser's terminal can no longer run anything on the daemon's host. Its chell used to declare that it could, so `!cmd`, host pipe segments, `edit` and `download` would have run on the daemon host. These requests now go to the browser that owns the terminal, which refuses `!` and host pipes by name, opens its own editor pane and saves downloads in the browser. Questions stay in the terminal. A terminal's chell marks for the page whether it is at its prompt, running a command or asking, and the page shows it as `data-terminal-state`. Ctrl-C at an open question now abandons it, so the command that asked is told and ends. Commands typed in the page's own terminal move the page as its console's commands always did: a game opens the GAMES pane, `say` speaks and a `cd` re-lists the files pane. An answered pane question is recorded in the terminal's scrollback. A line the terminal wrapped reads back as one line. The smoke suite drives either console (`SMOKE_CONSOLE=terminal|transcript`), and the nightly gains a transcript lane (#1125).
- 554fd24: The ARGUS console can be a terminal: press TERMINAL on the console's drawer, or type `console terminal`. xterm.js then draws the chell the daemon runs for this page, so the browser console is the same shell as a terminal's, with its own prompt, line editing, history, completion and questions in line with their output. It uses the console's font and colours, and a reload reattaches the same terminal. Touch devices get a key row (ESC, TAB, CTRL, arrows). The choice is remembered per device. A daemon that could not build node-pty offers no capsule, and the console stays the transcript. What ARGUS itself runs, such as a pressed DELETE's `rm -i` with its output and result, is mirrored into the terminal, and the daemon no longer echoes that command to the page's own consoles, so nothing prints twice. A pressed verb's question still stands on its pane, console open or closed, and a question with no pane is shown on a sheet over the stage. The transcript stays the default until the smoke drives the terminal (#1125).
- 6bde343: ARGUS's own words now work from any chell on the session, including `desktop show`, `view runs` and `dag census on`. A browser declares the subjects its language claims (whole subjects such as `dag`, `desktop` and `pane`, and only listed verbs of shared ones such as `file open` and `help keys`). The daemon then routes a single command in a claimed subject to that browser instead of the engine, and the chell prints the browser's answer. The browser that owns a chell's terminal answers first, then the most recently active one. With no browser attached, a subject claimed whole is refused by name, and a shared subject stays the session's. Tab completion offers the claimed words. A browser can also send a note to its own consoles, printed above the line being typed. A terminal's chell now tells the daemon which terminal it draws. This is the groundwork for ARGUS's console becoming a terminal (#1125).
- 7645d3c: The ARGUS console is the terminal wherever the daemon offers one; the transcript is a deprecated fallback for hosts without node-pty. The CONSOLE capsule and `console terminal|transcript` are gone; the transcript shows only where the daemon offers no terminal, and its first line says why (install python, make and g++ and reinstall). `CALYPSO_NO_PTY=1` starts a daemon that offers none, for exercising the fallback.

### Patch Changes

- Updated dependencies [90b7688]
- Updated dependencies [554fd24]
- Updated dependencies [6bde343]
  - @fnndsc/menu@0.24.0
  - @fnndsc/brasa@0.38.1
  - @fnndsc/cumin@3.27.15

## 0.22.0

### Minor Changes

- c73c81b: The daemon offers terminals: a browser's console can be a real chell, run under a pseudo-terminal. A surface sends `terminalOpen` with its size and receives the terminal's bytes as `terminalData`; it sends keystrokes back as `terminalInput`, and size changes as `terminalResize`. Each terminal is the same `chell --remote` a shell would run, attached back to this daemon over loopback. A terminal outlives the socket that opened it: opening it again by its id replays up to about 1 MB of recent output and carries on, even mid-command or mid-question. A terminal nobody is attached to closes after 15 minutes, and `exit` closes it at once. The pseudo-terminal comes from `node-pty` 1.1.0, an optional dependency compiled at install. A daemon where it did not build says `terminals: false` on attach and refuses `terminalOpen` with the reason. ARGUS's console moves onto this in the next release (#1125).
- 1a2a0d0: An open question shows across the session: `? N WAITING` on the ARGUS status strip, and `? N waiting` in chell's prompt. The daemon counts the questions open on every surface: they ride the heartbeat's lane (which surface asked what, and for how long) and every prompt context. ARGUS names each one in the strip's title and adds an ASKING row to the lane instrument; `who` says what each surface is waiting on. A question no longer freezes the session, so this is how a game paused in another tab, or a confirm left in a terminal, is not forgotten (#1128).
- 0746967: A command waiting on a question no longer freezes the session; other commands run until it is answered. While its question (or an editor) is open, other surfaces' commands run, and it takes its turn again when answered. Before, a trek waiting for a move, an `rm` waiting for "y" or a PACS confirm froze every pane verb and every other terminal until it was answered, or until an abandoned terminal was cleaned up. The daemon's queue is now a lane that a command gives up while it waits on a person and queues for again after the answer, resuming with its own routing. Brasa hands over each command's own state at the same two points: its exit code, a pipe's untaken input, a `play` manifest's depth, the recorder's mute and the Ctrl-C target. Each top-level line keeps its own error stack. Commands that ask now fix their targets before asking, so a `cd` from another surface cannot redirect the answer. `rm` resolves every operand first, `mv` and `cp` fix their sources, and a relative destination or PACS export path lands where the session stood when it asked (#1128).

### Patch Changes

- Updated dependencies [c73c81b]
- Updated dependencies [1a2a0d0]
- Updated dependencies [0746967]
- Updated dependencies [2ddbd41]
  - @fnndsc/menu@0.23.0
  - @fnndsc/brasa@0.38.0
  - @fnndsc/cumin@3.27.14

## 0.21.4

### Patch Changes

- dac084d: Attaching with chell --remote now finds the session porter started for you. A script on the same machine can attach to it directly, with no door or token; before, `chell --remote` said "No live calypso" while your session was running. A daemon you start by hand is still allowed beside porter's.

## 0.21.3

### Patch Changes

- Updated dependencies [a44990a]
  - @fnndsc/brasa@0.37.0

## 0.21.2

### Patch Changes

- Updated dependencies [e6b6ed8]
- Updated dependencies [a55f8db]
- Updated dependencies [b0b458b]
- Updated dependencies [739b2c5]
- Updated dependencies [79ac4a4]
- Updated dependencies [580af08]
  - @fnndsc/brasa@0.36.0

## 0.21.1

### Patch Changes

- 2086f4e: A download's row never freezes, and a cancelled download stays cancelled. Every question the row asks the session has a 5 s deadline: a session that stops answering reads LOST TOUCH WITH THE SESSION, and a cancel with no answer says so and can be pressed again. A cancel made while CUBE was still answering no longer lets the download start anyway.

## 0.21.0

### Minor Changes

- 3c8d56a: A download shows how far it has got, from the press to the end. A transfer row stands at the foot of the screen at once: waiting for CUBE, then bytes of the whole with the rate and the time left, then done, failed with CUBE's reason, or cancelled, with CANCEL to stop it. The daemon counts the bytes it passes (`/vfs?progress=<id>`, `cancel=<id>`) and holds the probe's stream for the browser's save, so CUBE is asked once instead of twice.

## 0.20.1

### Patch Changes

- 1b93202: A large file downloads, and a file in a feed shared with you downloads (#1061). A file stream has no 30 s deadline any more: CUBE held a 3.7 GB DICOM's first byte for up to a minute, and the old deadline killed every attempt. A watchdog fails a transfer only after two silent minutes, and says so. A file in a colleague's shared feed is read through CUBE's file browser, which serves it where `/userfiles/` answers 403. `download` names the kernel's reason (a stall, a refusal, a file too large to read whole) instead of "Failed to download file", and a file over 256 MB is never read whole into memory after a failed stream. ARGUS's DOWNLOAD streams through the daemon with its length in the header, so the browser draws its own progress and the daemon holds nothing whole.
- Updated dependencies [e29bf91]
- Updated dependencies [a0f0160]
- Updated dependencies [1b93202]
- Updated dependencies [b95fedf]
  - @fnndsc/cumin@3.27.12
  - @fnndsc/brasa@0.35.1
  - @fnndsc/menu@0.22.1

## 0.20.0

### Minor Changes

- 639b840: ARGUS over a backend other than ChRIS shows the frame alone: files, the console and its own tiles (#985). Before it builds, ARGUS asks the daemon `GET /backend` (token-gated; porter adds the token behind a door) and installs the ChRIS composition only for ChRIS; an older daemon is ChRIS. What ChRIS owns in the page's markup carries `data-composition`, and a saved ChRIS preset falls back to home. The FILES tile's description is the composition's (ChRIS keeps its own words). The smoke stage `frame-alone` checks both sides.
- 183aa7d: Nothing changes on screen: the daemon's attach answer names the session's backend, and ARGUS reads it (#985). menu's `attached` message gains an optional `backend`; calypso fills it from the backend it hosts (`chris`, `null`). ARGUS's `attachBackend_get` reads it, and an older daemon without the field is ChRIS, so a new ARGUS against an old calypso draws what it always drew.
- b9a83f1: Nothing changes in the browser: calypso no longer depends on ARGUS, and the launcher passes the web root (#984). `daemon_launch` takes `webRoot`; `CALYPSO_WEB_ROOT`, a bundle under the working directory and the enclosing checkout still come first. chell depends on `@fnndsc/argus` and passes the bundle it ships (porter launches through chell). The `calypso` command still defaults to ARGUS when it is installed beside it. `packageWebRoot_find(name, from)` finds the bundle any installed package ships.
- 9116e97: Internal: the calypso command can host the null backend for a test, with no ChRIS package loaded (#985). `CALYPSO_TEST_BACKENDS=1 calypso --backend null` hosts a session with no commands of its own and a filesystem in memory; without the variable the switch is refused. calypso's daemon code imports brasa's core entry, which now carries the version report and the logo. The calypso command loads brasa's ChRIS root only when it hosts ChRIS. A surface attached to the null daemon is told `backend: 'null'`.

### Patch Changes

- 43000d3: Nothing changes at the prompt: a daemon's berth name comes from its backend's account of who the session is (#982). The descriptor gains `session.identity_get()`, which returns a `SessionIdentity` (`user`, `where`, `connected`). For ChRIS that is the CUBE user at the CUBE URL, or `disconnected@no-cube` with no login, so every berth name, key and attach hint is the same as before. Each backend names its own disconnected session, so two backends never share one. calypso's launch reads the identity there and no longer imports cumin. chell keeps its folder, query and job checkpoints under the same name, through the backend. `identity_forSession` and `DISCONNECTED_IDENTITY` stay exported from calypso.
- e1085af: Nothing changes at the prompt: what it shows and what the daemon heartbeats come from the backend (#982). The descriptor gains `prompt` and `telemetry`, both in the wire's existing shapes (`PromptContext`, and `BackendTelemetry` with jobs, feeds, CUBE pace and job state). The ChRIS backend supplies its session prompt context and /proc snapshot; those files (`promptContext.ts`, `jobsState.ts`) move to `chris/` and are exported as before. calypso's launch takes both from the backend and imports neither. A backend without them gets no promptline or heartbeat providers. `lint:core-deps` drops to 14.
- Updated dependencies [183aa7d]
- Updated dependencies [43000d3]
- Updated dependencies [e1085af]
- Updated dependencies [27ce9b8]
- Updated dependencies [7e2fc05]
- Updated dependencies [4431568]
- Updated dependencies [d379168]
- Updated dependencies [11853c6]
- Updated dependencies [9b48f7c]
- Updated dependencies [90ede03]
- Updated dependencies [3bc7a27]
- Updated dependencies [11853c6]
- Updated dependencies [987f766]
- Updated dependencies [ebd7b3e]
- Updated dependencies [e32770c]
- Updated dependencies [27f3021]
- Updated dependencies [423971a]
- Updated dependencies [d3f1b1d]
- Updated dependencies [b5ae25d]
- Updated dependencies [77a914f]
- Updated dependencies [3175b3d]
- Updated dependencies [e1215ef]
- Updated dependencies [a12c6fc]
- Updated dependencies [9173d2c]
- Updated dependencies [11853c6]
- Updated dependencies [149adbf]
- Updated dependencies [fb31bef]
- Updated dependencies [e1215ef]
- Updated dependencies [9116e97]
- Updated dependencies [ec26525]
- Updated dependencies [0ac1bee]
- Updated dependencies [11853c6]
- Updated dependencies [6752575]
- Updated dependencies [60cb7f8]
- Updated dependencies [0fe1e18]
- Updated dependencies [e1215ef]
- Updated dependencies [1681476]
  - @fnndsc/menu@0.22.0
  - @fnndsc/brasa@0.35.0
  - @fnndsc/cumin@3.27.11

## 0.19.10

### Patch Changes

- 8d15909: Nothing changes for chell, ARGUS or porter users: the engine's output and surface contract now lives in menu. `OutputSink`, `Surface` and their companions are served as `@fnndsc/menu/surface`; brasa re-exports them, and the engine installs its own sink and surface. `BrasaEngine` gains required `sink_install` and `surface_install`, so code that implements it must add both.
- Updated dependencies [8d15909]
  - @fnndsc/menu@0.21.0
  - @fnndsc/brasa@0.34.0
  - @fnndsc/argus@0.27.2
  - @fnndsc/cumin@3.27.10

## 0.19.9

### Patch Changes

- Updated dependencies [5bb17f6]
  - @fnndsc/menu@0.20.0
  - @fnndsc/brasa@0.33.4
  - @fnndsc/cumin@3.27.9
  - @fnndsc/argus@0.27.1

## 0.19.8

### Patch Changes

- eb43996: The door and the daemon now say their version, through `porter --version` and `calypso --version` (or `-V`). porter prints its own version and the brasa, calypso and chell it would start sessions on; calypso prints its stack, as `chell --version` does.

## 0.19.7

### Patch Changes

- Updated dependencies [77e3eba]
- Updated dependencies [df34da0]
  - @fnndsc/argus@0.27.0
  - @fnndsc/cumin@3.27.7

## 0.19.6

### Patch Changes

- 9f4c181: The daemon's berth now records which package versions it runs and when it booted. A porter reads that to tell a session from before its last upgrade; older berths without the field count as older.

## 0.19.5

### Patch Changes

- Updated dependencies [c806e86]
  - @fnndsc/argus@0.26.0

## 0.19.4

### Patch Changes

- 5a0eef5: The package ships its release notes, so a session can say what changed. They are read from CHANGELOG.md at build into dist/notes.json.
- Updated dependencies [5a0eef5]
- Updated dependencies [5a0eef5]
- Updated dependencies [5a0eef5]
  - @fnndsc/brasa@0.33.0
  - @fnndsc/menu@0.19.0
  - @fnndsc/argus@0.25.0
  - @fnndsc/cumin@3.27.5

## 0.19.3

### Patch Changes

- 6901a81: The daemon answers the kernel's `peers` seam with the surfaces attached to the session, so `who` can name them (the games shelf, #892).
- Updated dependencies [6901a81]
- Updated dependencies [6901a81]
  - @fnndsc/brasa@0.32.0
  - @fnndsc/argus@0.24.0

## 0.19.2

### Patch Changes

- Updated dependencies [73c0087]
  - @fnndsc/menu@0.18.0
  - @fnndsc/brasa@0.31.5
  - @fnndsc/argus@0.23.2
  - @fnndsc/cumin@3.27.4

## 0.19.1

### Patch Changes

- Updated dependencies [c9f9156]
- Updated dependencies [d04a2ef]
  - @fnndsc/argus@0.23.0

## 0.19.0

### Minor Changes

- 51315ec: The calypso daemon knows when it is stale. It fingerprints its own packages' code (version and compiled scripts' content) when it starts, reads the fingerprint again on every attach and once a minute, says `stale` in its attach ack, and pushes a `stale` message when the answer flips. ARGUS says CALYPSO DAEMON OUT OF DATE only when the daemon says so, so an ARGUS-only release no longer alarms every running daemon; an open ARGUS learns of an upgrade within a minute. A daemon too old to report `stale` falls back to the build-stamp comparison.
- 33e4f1d: A session restarts from its own browser and stays logged in. Porter's new `POST /restart` (cookie-gated: only the cookie's own session) tells the old calypso daemon why, ends it, and boots a fresh one with chell's new `--saved-token` login, which uses the token the identity saved and refuses rather than come up offline. The browser follows the boot on the greeter; a refused saved token ends at the door with the reason. On SIGTERM the daemon sends `closing` (restart, end or stop) to every surface before it exits, and a remote chell prints why it went. `porter --end` leaves `end` as the reason.
- fe4b6b4: The calypso daemon is restarted by its own operator, behind a door. A RESTART pill stands beside LOG OUT, and the out-of-date notice's cure "Restart the calypso daemon" is a control. Both ask first in the notice's spot ("Restart the calypso daemon? You'll stay logged in; …"), naming what a restart would cut off right now: the running command, unsaved edits, other attached browsers and chells. YES asks the door to restart and follows the greeter back in; another ARGUS on the session says why it dropped and follows on its own. The daemon's heartbeat now lists the attached surfaces (id and kind) and its attach ack gives each surface its own id.

### Patch Changes

- Updated dependencies [51315ec]
- Updated dependencies [33e4f1d]
- Updated dependencies [fe4b6b4]
- Updated dependencies [2d26368]
  - @fnndsc/menu@0.17.0
  - @fnndsc/argus@0.22.0
  - @fnndsc/cumin@3.27.2
  - @fnndsc/brasa@0.31.2

## 0.18.0

### Minor Changes

- 685ed59: ARGUS and the calypso daemon say when they are different builds. ARGUS's build writes its stamp into the bundle; the calypso daemon reads it once at start and reports it in its attach ack (`stack.surface`, optional in the wire schema). When ARGUS's own stamp differs, it says which is older and what to restart — on the status strip, in a dismissible notice, and on the console: "ARGUS is newer than the calypso daemon, so some controls won't work. Restart the calypso daemon." or "ARGUS is older than the calypso daemon. Refresh to load the new ARGUS." A remote chell prints one line at attach when its build differs from the daemon's.

### Patch Changes

- Updated dependencies [685ed59]
  - @fnndsc/argus@0.21.0
  - @fnndsc/menu@0.16.0
  - @fnndsc/brasa@0.31.1
  - @fnndsc/cumin@3.27.1

## 0.17.1

### Patch Changes

- Updated dependencies [4128890]
  - @fnndsc/argus@0.20.0

## 0.17.0

### Minor Changes

- c1cf57e: An edit crosses the wire to a browser (#831, slice 2). The daemon's `edit` request now names the file being edited (`path`), and a surface may answer `opened`: it took the file into an editor that stays open, so the command saves nothing and says `(opened in the editor)`; each save made in that editor will run as its own command line. The argus client hands an edit to a host editor hook and answers at once that it opened, or refuses in words when it has none (the hook is installed by the editor pane, slice 3). `feed note edit N` is now `edit /proc/jobs/feed_N/note`: a terminal's editor and a browser's pane open the same text and save it the same way, and the title is set with `feed note N --title`.

### Patch Changes

- Updated dependencies [e057d20]
- Updated dependencies [2826f2b]
- Updated dependencies [c1cf57e]
- Updated dependencies [50d41d7]
- Updated dependencies [1c8b92d]
- Updated dependencies [e20fb09]
- Updated dependencies [ddbd551]
- Updated dependencies [32e3919]
- Updated dependencies [59399fe]
- Updated dependencies [51da853]
  - @fnndsc/argus@0.19.0
  - @fnndsc/brasa@0.31.0
  - @fnndsc/menu@0.15.0
  - @fnndsc/cumin@3.27.0

## 0.16.10

### Patch Changes

- Updated dependencies [88437cc]
- Updated dependencies [51f1ca9]
- Updated dependencies [c9c018b]
- Updated dependencies [55fbf6c]
- Updated dependencies [fbb1579]
- Updated dependencies [576b948]
- Updated dependencies [4864a34]
- Updated dependencies [40acb72]
- Updated dependencies [d7ec90d]
- Updated dependencies [d057e99]
- Updated dependencies [4863f32]
- Updated dependencies [7fb4c21]
- Updated dependencies [8260d33]
- Updated dependencies [c371b47]
  - @fnndsc/argus@0.18.10
  - @fnndsc/brasa@0.30.0
  - @fnndsc/cumin@3.26.0
  - @fnndsc/menu@0.14.0

## 0.16.9

### Patch Changes

- cbd71cc: A refused file read says why: the kernel names the status and reason (403 not yours to read, 404 no such file, 502 CUBE could not serve it), `/vfs` answers with them instead of 404 for everything, and an image pane that lost a slice reads the reason out. `porter --end <who>` ends one session so the next login boots on the current kernel.
- Updated dependencies [cbd71cc]
  - @fnndsc/brasa@0.29.1
  - @fnndsc/argus@0.18.8

## 0.16.8

### Patch Changes

- Updated dependencies [fbd3f0a]
- Updated dependencies [fbd3f0a]
  - @fnndsc/menu@0.13.0
  - @fnndsc/brasa@0.29.0
  - @fnndsc/argus@0.18.0
  - @fnndsc/cumin@3.25.0

## 0.16.7

### Patch Changes

- Updated dependencies [a0927ec]
- Updated dependencies [e61a6ad]
- Updated dependencies [e7f82dd]
- Updated dependencies [d1da8ac]
- Updated dependencies [0f9ae74]
- Updated dependencies [7c1250f]
- Updated dependencies [16f8558]
- Updated dependencies [8851db3]
- Updated dependencies [d8e160c]
- Updated dependencies [e59a8d7]
- Updated dependencies [5aec39e]
- Updated dependencies [8cd7a3a]
  - @fnndsc/argus@0.17.0
  - @fnndsc/cumin@3.24.0
  - @fnndsc/menu@0.12.0
  - @fnndsc/brasa@0.28.0

## 0.16.6

### Patch Changes

- Updated dependencies [53d43f6]
- Updated dependencies [38572b6]
  - @fnndsc/brasa@0.27.0
  - @fnndsc/argus@0.16.2

## 0.16.5

### Patch Changes

- Updated dependencies [5ccff72]
  - @fnndsc/argus@0.16.0

## 0.16.4

### Patch Changes

- Updated dependencies [b92c96a]
- Updated dependencies [d6dac25]
- Updated dependencies [6233301]
- Updated dependencies [5caeef6]
  - @fnndsc/argus@0.15.0

## 0.16.3

### Patch Changes

- Updated dependencies [b254ee4]
- Updated dependencies [7b89dcc]
- Updated dependencies [11a0dd1]
- Updated dependencies [f3f68e3]
- Updated dependencies [cb76c3b]
- Updated dependencies [f2b6a80]
- Updated dependencies [f297468]
  - @fnndsc/argus@0.14.0
  - @fnndsc/brasa@0.26.0

## 0.16.2

### Patch Changes

- Updated dependencies [6b55e72]
- Updated dependencies [5b78288]
- Updated dependencies [5a95cac]
  - @fnndsc/cumin@3.23.2
  - @fnndsc/argus@0.13.0

## 0.16.1

### Patch Changes

- Updated dependencies [de26df4]
- Updated dependencies [247bf09]
- Updated dependencies [dac2d96]
- Updated dependencies [dac2d96]
- Updated dependencies [dac2d96]
- Updated dependencies [50f8a4e]
- Updated dependencies [50f8a4e]
- Updated dependencies [50f8a4e]
- Updated dependencies [637c819]
- Updated dependencies [c82f514]
- Updated dependencies [c82f514]
- Updated dependencies [c82f514]
- Updated dependencies [c82f514]
  - @fnndsc/argus@0.12.0
  - @fnndsc/cumin@3.23.1
  - @fnndsc/brasa@0.25.0
  - @fnndsc/menu@0.11.0

## 0.16.0

### Minor Changes

- 3a8cd1b: A porter at the door: the mise display manager, slice 3 — the shape without the door.

  `apps/porter` logs an operator into one CUBE, trades the password for a token, starts or joins that identity's calypso (`chell --daemon --auth-token-stdin`, the token on stdin, four directories of its own under the porter's state) and mounts the session at `/s/<key>/`: page, assets, `/vfs` and the WebSocket wire proxied to the daemon on loopback with the attach token added by the porter, so the browser holds none. `GET /boot/<key>` streams the session's boot as server-sent events, one per line the daemon wrote, replayed for a late attacher. `POST /sessions` re-checks the password at CUBE every time, even when the session is up.

  calypso: the attach token may ride the upgrade URL (`?token=`), the way `/vfs?token=` already does, so a front that holds the token for a browser can put it on the proxied upgrade and the page attaches with an empty one; and `berth_pathIn(runtimeDir, identity)` names a berth under a runtime directory that is not the process's own.

  No cookie yet: this porter binds loopback. The door — login page, cookie, LOG OUT — is the next slice.

- 1bdf876: A row wears the number it answers to.

  A row of the session's last answer can be named by the number beside it — `gather add @2,3,6`, `image @1` — so the number is now DRAWN beside it. The listing façade mints a leading index pill for any level that says how its rows are addressed, and no pane draws a number itself.

  What is numbered is the kernel's ANSWER rather than a rendering of it, so a console table and a graphical pane count the same rows. The lit number is found BY ADDRESS, not by counting down the screen, so a sorted or filtered listing keeps each row's own number instead of renumbering under the operator.

  Every listing leads with the column and every row counts itself; only the rows the kernel reaches wear a LIT number. In a PACS answer that is the series, while the patient and study levels above count themselves dim — the distinction is the hue, never the digits, so a number nothing answers to cannot be mistaken for one that does. Numbers are zero-padded to the widest in their group, so a fourteen-series answer reads 01…14 and the column stays a column. The lit hue is the pane's FRAME hue (`--listing-index-hue`, set per pane), because the pill is chrome and not content: an orange pill beside the browser's orange kind glyph read as one blob and the number stopped being a number.

  The surface learns which listing is numbered from a retained `numbered` message: brasa announces it as the answer changes, calypso relays it and replays it to a surface attaching late, and the addresses travel with it (capped, past which a long listing is numbered in the kernel and unnumbered on screen). The same shape regard already travels in.

  Law: `a-row-wears-the-number-it-answers-to`.

- 5b520c7: An index says what it counts.

  `@2` said nothing about what it counted — in a PACS answer every study read "1", being the only study under its patient — so a bare number is no longer an index. A handle names its KIND and its place in that kind's sequence: `@SER3`, `@STD001`, `@FIL2,3,7`, `@DIR2-4`. One sequence per kind runs across the whole answer, so a handle is a name rather than a position and a sorted listing does not renumber it; zero padding is how the pill draws it, not something to type.

  What a row hands over differs by kind. A series, a file or a folder hands over its path; a STUDY hands over its series — what the surface's GATHER on a study hands over — so `gather add @STD001` and `pull @STD001` act on the whole study from a console exactly as a press does. A verb refuses a kind it does not take, by name and at expansion: `image @STD001` says "image takes a series or a folder or a file; STD001 is a study" instead of resolving to a path and failing three steps later for a reason that names nothing typed.

  On the surface the pill draws the handle, lit in the pane's frame hue on the rows the session reaches, and a study row wears `STD001` where it read a meaningless "1". The `numbered` message carries each row's kind, place and address, so a pane finds its rows by address and draws the code the operator would type.

### Patch Changes

- d1a1c0d: calypso: `/vfs?path=…&download=1` answers the file's bytes as an attachment named for the file (`content-disposition`, the name as ASCII and as UTF-8), so a browser surface can save a file rather than show it.
- 4ee180c: A session outlives its door: the porter's lifecycle.

  porter: a restarted porter adopts the sessions its predecessor started, from their berths under the state directory, rather than starting rivals. Idle sessions — no wire open, nothing through the door for `PORTER_IDLE_HOURS` (a day, like the cookie) — are ended by a sweep every minute: the process only; the state directory stays and the next login boots warm. `porter --status` lists the state directory's sessions and whether each answers. `deploy/` carries a systemd unit (a `porter` user, `KillMode=process` so a stopped door keeps its sessions), an env file example, and a Caddyfile for TLS in front. Boot lines kept per session are capped at 2000.

  calypso: a berth records the daemon's pid, so a host that did not start a daemon can still end it.

  chell: a daemon off a TTY tolerates EPIPE on its stdout and stderr — the porter that started it may stop first, and a session outlives its door.

- Updated dependencies [e74ce1d]
- Updated dependencies [1b2f7f7]
- Updated dependencies [50f358b]
- Updated dependencies [3320487]
- Updated dependencies [149957f]
- Updated dependencies [161e54d]
- Updated dependencies [07f3783]
- Updated dependencies [f94480e]
- Updated dependencies [2322151]
- Updated dependencies [0f3deaa]
- Updated dependencies [d1a1c0d]
- Updated dependencies [fa26e17]
- Updated dependencies [77c73aa]
- Updated dependencies [cd7714d]
- Updated dependencies [a010cb0]
- Updated dependencies [369b20d]
- Updated dependencies [8a8dc25]
- Updated dependencies [b748002]
- Updated dependencies [a8e0f87]
- Updated dependencies [dc369d3]
- Updated dependencies [d3a8335]
- Updated dependencies [03e0f87]
- Updated dependencies [1bdf876]
- Updated dependencies [854ba2e]
- Updated dependencies [80ddce6]
- Updated dependencies [9cc1514]
- Updated dependencies [3bbc65a]
- Updated dependencies [1cb8d03]
- Updated dependencies [4ce1ddc]
- Updated dependencies [5b520c7]
- Updated dependencies [9339853]
- Updated dependencies [acbade9]
- Updated dependencies [3c6a0d3]
- Updated dependencies [ca3e39b]
- Updated dependencies [7bba167]
- Updated dependencies [21f8d21]
- Updated dependencies [9c5a7c2]
- Updated dependencies [1c169d7]
- Updated dependencies [fc4eb7e]
- Updated dependencies [43b9440]
- Updated dependencies [d78447d]
- Updated dependencies [38fbdb9]
  - @fnndsc/brasa@0.24.0
  - @fnndsc/argus@0.11.0
  - @fnndsc/menu@0.10.0
  - @fnndsc/cumin@3.23.0

## 0.15.2

### Patch Changes

- Updated dependencies [6c6ca51]
- Updated dependencies [48e112d]
- Updated dependencies [cd6a0ab]
- Updated dependencies [ee75252]
- Updated dependencies [fa90f05]
- Updated dependencies [934d2d3]
- Updated dependencies [de5508d]
  - @fnndsc/argus@0.10.0
  - @fnndsc/brasa@0.23.2

## 0.15.1

### Patch Changes

- Updated dependencies [3f96d86]
- Updated dependencies [0d99ec5]
- Updated dependencies [a38bb64]
- Updated dependencies [ab127ea]
- Updated dependencies [0d5f0d7]
- Updated dependencies [3c6555a]
- Updated dependencies [7c2308b]
- Updated dependencies [6d8a595]
- Updated dependencies [a4a38b1]
- Updated dependencies [0d99ec5]
- Updated dependencies [a4a38b1]
- Updated dependencies [3c9af17]
- Updated dependencies [480632d]
- Updated dependencies [b4d9282]
- Updated dependencies [566be78]
- Updated dependencies [62ef29b]
- Updated dependencies [f6d818b]
- Updated dependencies [97596db]
- Updated dependencies [15b8875]
- Updated dependencies [aef1a8d]
- Updated dependencies [35064c8]
- Updated dependencies [b337285]
- Updated dependencies [59a3f96]
- Updated dependencies [f549b09]
- Updated dependencies [4aaad51]
- Updated dependencies [ab127ea]
- Updated dependencies [480632d]
- Updated dependencies [10b99d2]
- Updated dependencies [66ecf22]
- Updated dependencies [2d52827]
- Updated dependencies [5d4bb4d]
- Updated dependencies [d3e5494]
- Updated dependencies [6d8a595]
- Updated dependencies [3f45362]
- Updated dependencies [b329170]
- Updated dependencies [3f96d86]
- Updated dependencies [2080342]
- Updated dependencies [7126bca]
  - @fnndsc/brasa@0.23.1
  - @fnndsc/argus@0.9.0

## 0.15.0

### Minor Changes

- 9cf2ea2: `image <path>`'s text reflection now carries a thumbnail of the middle slice, so a TTY sharing the session shows the picture, not only the facts. The kernel reads the slice's pixels (`dicomSlice_gray` in salsa, uncompressed transfer syntaxes via dcmjs), window/levels to 8-bit with MONOCHROME1 inverted, and box-downsamples to a cell grid; brasa renders it as an ASCII ramp on any pipe or ANSI truecolour half-blocks (`▀`) on a colour terminal. Colour is a new declared surface capability: ARGUS declares it (its DOM console renders ANSI), chell reads its own terminal through chalk, a bare pipe gets the ramp. Compressed pixels say so in one line rather than pulling a codec into the kernel; an unreadable slice leaves the facts and no picture. The ASCII ramp is always the floor.

### Patch Changes

- Updated dependencies [7892529]
- Updated dependencies [a24d813]
- Updated dependencies [de4dac8]
- Updated dependencies [26eaf6a]
- Updated dependencies [b6d0264]
- Updated dependencies [7ca8d04]
- Updated dependencies [67f5fd5]
- Updated dependencies [9cf2ea2]
- Updated dependencies [d133ef6]
- Updated dependencies [7b5a7b9]
- Updated dependencies [c70e11e]
- Updated dependencies [6990c3a]
- Updated dependencies [aa486c5]
- Updated dependencies [b4689e2]
- Updated dependencies [a29635a]
- Updated dependencies [0215547]
- Updated dependencies [bf4c118]
- Updated dependencies [5ed1785]
- Updated dependencies [887c815]
- Updated dependencies [8a4ddc8]
  - @fnndsc/argus@0.8.0
  - @fnndsc/brasa@0.23.0
  - @fnndsc/menu@0.9.0
  - @fnndsc/cumin@3.22.1

## 0.14.0

### Minor Changes

- c601a42: ARGUS is published, and a released install now serves it. `@fnndsc/argus` ships its built bundle, calypso depends on it, and the daemon's web-root search ends by resolving the installed package — so `npm install -g @fnndsc/chell` followed by `chell --daemon` prints a URL a browser can open, where before it printed only a WebSocket address. The unused `@fnndsc/calypso` dependency is dropped from argus, whose browser code imports only the wire contract.

### Patch Changes

- Updated dependencies [c601a42]
- Updated dependencies [3660509]
- Updated dependencies [c0e92f7]
  - @fnndsc/argus@0.7.0

## 0.13.2

### Patch Changes

- 4af65f4: The daemon now tells a browser how long it may keep what it serves. It sent a content type and nothing else, and silence is not neutral: with no `cache-control`, no `etag` and no `last-modified` a browser may keep the page, and `index.html` is the file that names the hashed assets — so a kept copy pinned the whole surface to the build that wrote it and no rebuild ever arrived. `index.html` is `no-store`, a hashed asset is immutable for a year since a different build is a different URL, and anything else revalidates.
- Updated dependencies [163e4b1]
- Updated dependencies [aa923c6]
- Updated dependencies [59aa79b]
  - @fnndsc/brasa@0.22.0
  - @fnndsc/cumin@3.22.0

## 0.13.1

### Patch Changes

- Updated dependencies [7c793ad]
- Updated dependencies [7c793ad]
- Updated dependencies [af2df66]
- Updated dependencies [af2df66]
- Updated dependencies [0eb202f]
- Updated dependencies [183bf02]
  - @fnndsc/brasa@0.21.0
  - @fnndsc/menu@0.8.0
  - @fnndsc/cumin@3.21.1

## 0.13.0

### Minor Changes

- ef4a718: The standalone `calypso` binary ends its boot at a login, like `chell --daemon`: on a TTY the daemon's own terminal becomes its first surface, an ordinary `chell --remote` spawned onto it, rather than the old resting face. The console loop, the cage and the reattach grammar move into calypso (the daemon's own package), with the surface launch injected — chell spawns itself, the calypso binary spawns `chell` from the path — so both hosts share one console. Off a TTY neither attaches; the daemon just keeps listening.

## 0.12.0

### Minor Changes

- 9c320a0: The boot ends at a login. An interactive `chell --daemon` no longer rests on the console face: once the daemon is listening it puts an ordinary `chell --remote --attach` surface on its own terminal, as a child on the wire, so the boot log runs straight into a prompt. `exit` detaches and leaves the daemon running, Enter attaches again, Ctrl-C at the idle terminal stops the daemon, and whatever the daemon writes while a surface holds the terminal is held (calypso `consoleCage_start`/`consoleCage_stop`) and printed on detach. Every chell REPL, local or remote, now guards its idle prompt: a stray line (another surface's output, a late warm-up) lands on its own line with the prompt redrawn beneath it.

  The boot readout is lifted with it. A warm-up step running behind the prompt printed its pending row twice and never reported an outcome; it now prints once as `[PENDING]` and settles on the daemon's readout as `[ OK ]` with what it cached or `[FAIL]` with why. Every count takes its noun in the right number (`1 PACS query`, `3 feeds`) through a new brasa `count_noun`. The daemon banner writes every package out in full (brasa `stackBanner_build`/`stackBanner_compose`), adds an ARGUS row when a web surface is served, and drops the welcome; the remote surface banners the daemon's stack the same way. A daemon bound on every interface advertises its fully qualified host name.

### Patch Changes

- 89d3287: Daemon boot leaves no open `[PENDING]` row. The steps that warm behind the prompt were settling after the login took the terminal, which caged them, so their `[ OK ]` never reached the row and it stayed `[PENDING]` on screen. The boot now waits those steps out before the login — they settle in place, every row reading `[ OK ]` or `[FAIL]` — while the daemon is already listening, so nothing reaches it any later for the wait. The startup banner keeps its version column clean: the build hash moves from the CALYPSO row, which it pushed past the column the other rows share, to the `listening` line. The fortune is gone from daemon startup.
- Updated dependencies [3d11f59]
- Updated dependencies [9c320a0]
- Updated dependencies [711e1b3]
- Updated dependencies [d89e31b]
  - @fnndsc/brasa@0.20.0
  - @fnndsc/cumin@3.21.0
  - @fnndsc/menu@0.7.0

## 0.11.0

### Minor Changes

- 49634f2: feat(calypso): the telemetry heartbeat carries the lane — the command holding it, for how long, how many wait behind it — and CUBE's pace
- 2545ffa: feat(calypso): the telemetry heartbeat carries the lab's pulse the engine snapshots

### Patch Changes

- Updated dependencies [49634f2]
- Updated dependencies [49634f2]
- Updated dependencies [49634f2]
- Updated dependencies [2545ffa]
- Updated dependencies [2545ffa]
  - @fnndsc/brasa@0.19.0
  - @fnndsc/cumin@3.20.0
  - @fnndsc/menu@0.6.0

## 0.10.2

### Patch Changes

- Updated dependencies [6cd5ab1]
- Updated dependencies [6cd5ab1]
- Updated dependencies [6cd5ab1]
- Updated dependencies [57ba039]
- Updated dependencies [57ba039]
- Updated dependencies [57ba039]
- Updated dependencies [adf8cc1]
- Updated dependencies [98ab832]
- Updated dependencies [98ab832]
- Updated dependencies [98ab832]
  - @fnndsc/brasa@0.18.0
  - @fnndsc/cumin@3.19.0
  - @fnndsc/menu@0.5.0

## 0.10.1

### Patch Changes

- 53a736f: fix(calypso): a feed's topology walk is annunciated on a quiet daemon

  The heartbeat re-pushed the promptline only when the index counts moved or the previous push still showed warm-up. A feed's topology walk (a first visit, `proc refresh`) reports its progress into the prompt context page by page but adds its instances to the index only once the walk is done, so on a quiet daemon the counts stood still for the whole walk and the JOBS readout never named the feed — it was annunciated only when a background sweep happened to be moving the counts at the same time. The heartbeat now also pushes while a foreground command is executing, which is exactly when a walk can be in flight.

## 0.10.0

### Minor Changes

- a7f057c: feat: a value-taking flag given no value asks for it

  `pacs query … --csv-to` with nothing after it now means "ask me where". Before, such a flag was silently ignored: the operator asked for a table and got none, which is worse than either answering or refusing.

  No sigil was needed. `?` was the obvious spelling and is already a glob in `string_checkHasWildcard`, so it would have expanded against the VFS; a flag that takes a value and is given none is unambiguous on its own, and the rule now generalises to every flag in the stack without another convention.

  The ask carries what it wants — a `path`, with the session's own cwd as its anchor, a suggested basename, and `EXPORT HERE` as the word its committing control should read. The anchor is a fact rather than a guess: inventing a directory means creating one behind the operator's back. And it is raised only once there is something to write, since a question about a file that may never exist is asked too early.

  Two rules ride with it, both in the daemon, both about who may interrupt an operator:

  - **A command marked `instrument` may never ask.** A pane's silent refresh or an ambient cycler raising a question is refused outright — the operator did not issue that command and cannot answer for it.
  - **One question at a time per surface.** A second is refused by name rather than queued, because a queued question is one whose command the operator has forgotten issuing.

  An abandoned ask is not a failed query: the answer stands and only the writing does not happen.

  `prompt_current` now takes the whole request rather than a message and a flag, and the daemon relays `wants`, `path` and `commit` to the surface. `repl_confirm` and `repl_questionPath` join the kernel's ask helpers, so a caller states the kind once and every surface reads the same intent.

- 78d85ae: feat(argus): a location is asked for by borrowing a browser

  An ask is never a box. A `path` question opens the instrument that already shows that space: a **new** files pane beside the pane that asked — never an existing browser, since hijacking one loses the operator's place — anchored where the ask said, closing when the errand ends either way.

  Its controls ride a bar of its own across the top of the pane: the question as a caption, the composed path as an editable field, **MKDIR** for a folder that does not exist yet, and one verb that commits, reading the word the kernel sent (`EXPORT HERE`). The grill had put those on the mode frame; building it showed why they cannot live there — the frame is a narrow rail against the spine, right for a column of capsules and hopeless for a caption and a path, and it answers to what the _field_ holds, which an errand does not change.

  Three defects the live run turned up, each fixed here:

  - **The errand opened an empty browser, forever.** The daemon runs commands one at a time, so the listing that would answer the question queued behind the command that asked it: the answer waiting on the browsing, the browsing waiting on the answer. An instrument command now runs **beside** a command waiting on a question — the natural twin of the rule that an instrument may never ask. A pane's own read neither asks nor waits, and the daemon saves and restores the executing command rather than clearing it, so the outer command's output still finds its way home.
  - **The errand split beside the focused pane**, which can be one the current preset does not hold. A split beside a pane that is not in the tree fails silently, and an errand that never opens is a question asked of nobody. The host is now a leaf that is actually on stage.
  - **The anchor could be somewhere nothing can be written.** A session sitting in `/bin` or `/proc` is browsing a provider, not standing where a file lands, so the ask falls back to home rather than offering a destination that is refused the moment it is committed.

  Law `an-ask-borrows-an-instrument`, smoke-enforced. Two consecutive full smoke runs, 103 checks.

- 9e2a9dd: feat: a verb that acts on the place rides the frame — MKDIR and UPLOAD

  Two verbs act on the PLACE the field holds rather than on any row, so they ride the field's own frame beside HOME and BACK, and they appear on a browser's frame and nowhere else — there is no directory to make in a list of feeds.

  **MKDIR** asks for a name in the console and makes it where the field points, not where the session's cwd happens to be: a rooted browser is showing a place of its own, and a verb that acted on the session's place instead would make the folder somewhere the operator is not looking.

  **UPLOAD** is the verb this surface could not previously speak at all. `upload` reaches the daemon's disk, which a browser has never seen. So the operator's own picker chooses the file, and the bytes travel over the daemon's `/vfs` route — now answering `POST` as well as `GET` — where the **engine** writes them through the kernel. No surface talks to CUBE, the same attach token gates the write as gates the read, and the body is capped. The console keeps the account, because a gesture the surface performs itself still owes the transcript what it did.

  New seam: `Engine.file_write(path, bytes)`, the twin of `file_read`. It writes through salsa's own create and **invalidates the listing it changed**, as every writing builtin does — without that the browser asks for the folder again and is served the folder as it was before the delivery, which reads as an upload that silently did nothing.

### Patch Changes

- 3df1c41: docs(calypso): say calypso where the component is meant, and make it typeable

  Every other part of the stack is a noun with a role — cumin, salsa, chili, brasa, menu, chell, argus. The session supervisor was the odd one out, described by a flag on another program, so the prose said "the daemon" for something that already has a name, a package, a binary and a doctrine document.

  Host control is _calypso's_ policy; berths are calypso's; the wire is calypso's. "Grant calypso host access" says whose policy changed. "Grant the daemon" does not.

  Operator-facing text now names it: the flag help, the not-running message, the already-running refusal, the listening banner, the attach errors, the several-sessions chooser, and the host-control sentences — `upload` refusing without the `files` tier, the HOST banner, and argus's HOST lamp tooltip.

  The start hints used to read `chell --daemon <user>@<url>` while the prose said "run calypso". They now say `calypso <user>@<url>`, which is a real command, since calypso ships its own binary. The getting-started guide leads with what calypso _is_, then gives both ways to start it — standalone from a saved session, or through chell logging in fresh — because they genuinely differ and one does not replace the other.

  **Daemon survives where it is correct**: a mode name, an anchor, a make target, a background process. Code symbols are untouched — `daemon_launch` and its kin describe something that really is a daemon, and churning them buys nothing an operator sees. Command lines inside code blocks were left alone, so nothing became a command that does not exist.

- Updated dependencies [a7f057c]
- Updated dependencies [da15f3b]
- Updated dependencies [78d85ae]
- Updated dependencies [349d7d2]
- Updated dependencies [8312a79]
- Updated dependencies [02ef648]
- Updated dependencies [3df1c41]
- Updated dependencies [f5c16fe]
- Updated dependencies [116e8ba]
- Updated dependencies [ec3ef9f]
- Updated dependencies [6234d55]
- Updated dependencies [ba1e5b4]
- Updated dependencies [404f5e3]
- Updated dependencies [7181f7e]
- Updated dependencies [d2a4315]
- Updated dependencies [a245b5f]
- Updated dependencies [9e2a9dd]
- Updated dependencies [5a339f0]
- Updated dependencies [a8449bc]
- Updated dependencies [8446459]
- Updated dependencies [17964a9]
- Updated dependencies [62761a3]
- Updated dependencies [17964a9]
  - @fnndsc/brasa@0.17.0
  - @fnndsc/cumin@3.18.0
  - @fnndsc/menu@0.4.0

## 0.9.1

### Patch Changes

- e3948f1: fix(release): publish `@fnndsc/menu`, without which nothing else installs

  `@fnndsc/menu` was marked private, so changesets versioned it and then skipped publishing it. cumin, brasa, chell and calypso all depend on it, so every published version since menu was extracted has been uninstallable from a clean registry:

  ```
  npm install @fnndsc/brasa
  npm error 404  The requested resource '@fnndsc/menu@*' could not be found
  ```

  It worked in development only because the workspace resolves menu locally, and it went unnoticed because nothing ever installed these packages from npm alone.

  menu is an ordinary library — the wire schemas and types three published packages import. Its manifest was already publish-ready and identical in shape to its siblings; only the flag stood in the way. It is dropped.

  The dependency range is pinned to `^0.3.0` at the same time. `"*"` was an artefact of menu being private, since changesets does not rewrite ranges for packages it will not publish, and `"*"` on a published dependency means any future breaking change applies silently.

  `argus` stays private, and correctly so: it is a browser bundle served from calypso's web root, not a library anyone imports.

- Updated dependencies [e3948f1]
  - @fnndsc/menu@0.3.1
  - @fnndsc/cumin@3.17.1
  - @fnndsc/brasa@0.16.1

## 0.9.0

### Minor Changes

- 4f034b9: Host control: `chell --daemon --host-control[=shell,files,pipes]` lets the daemon declare capabilities of its own — `!` runs on the daemon host, pipe segments run there, `upload`/`download` reach its disk — off by default, refused on a non-loopback bind without `--expose-host-control`, and annunciated everywhere (attach ack `hostControl`, the daemon face, the prompt's HOST segment, a remote shell's banner). Without the `files` tier, `upload` under a daemon now refuses instead of reading the daemon host's disk.

### Patch Changes

- Updated dependencies [f73e6c2]
- Updated dependencies [5dc064e]
- Updated dependencies [75f1e5f]
- Updated dependencies [3afaa65]
- Updated dependencies [5b4b7db]
- Updated dependencies [eaf6c67]
- Updated dependencies [73aa61a]
- Updated dependencies [4f034b9]
- Updated dependencies [aa25502]
- Updated dependencies [f8d1b1c]
- Updated dependencies [85c6813]
  - @fnndsc/cumin@3.17.0
  - @fnndsc/menu@0.3.0
  - @fnndsc/brasa@0.16.0

## 0.8.0

### Minor Changes

- 97af423: Watches: a surface can keep a running feed live. New wire pair `watch` / `unwatch` (subject = `/proc/jobs/feed_N`, owned per surface, released on detach) and a `watched` report (`live` | `settled` | `stale`). While anyone watches a feed the engine samples it on an adaptive cadence (3 s while it changes, backing off to 30 s when quiet), and whenever a visit changes the cache it publishes the refreshed `feed.dag` model to every surface as a session-bus envelope from the `daemon` surface, off the scrollback. A feed that settles reports `settled` and the watch ends; a failed sample reports `stale` and keeps trying. `proc watch <feed>` / `proc unwatch <feed>` are the console forms (`proc watch` lists). The engine gains an ambient event bus for events it originates on its own. Feed visits within one second of each other now share one sync, and `feedVisit_sync` reports whether it succeeded.

### Patch Changes

- Updated dependencies [920e0ac]
- Updated dependencies [7a0f06e]
- Updated dependencies [920e0ac]
- Updated dependencies [c716624]
- Updated dependencies [cece0dc]
- Updated dependencies [97af423]
  - @fnndsc/cumin@3.16.0
  - @fnndsc/brasa@0.15.0
  - @fnndsc/menu@0.2.0

## 0.7.1

### Patch Changes

- Updated dependencies [85791b3]
  - @fnndsc/brasa@0.14.0

## 0.7.0

### Minor Changes

- eebdc7d: A daemon writes its attach addresses to a file, and keeps its boot animation.

  Stopping the brain-activity pulse in daemon mode made the terminal easy to
  select from and the session feel dead. The animation stays; the addresses are
  written where they can be read without fighting a repainting screen or
  surviving a `clear`.

  The note lands at `/tmp/calypso-<user>.attach`, and the banner names it. It
  carries the attach token, which is a credential, in a world-readable directory
  — so it is created `0600`, created exclusively so a symlink planted at the path
  makes the write fail rather than land somewhere of an attacker's choosing, and
  removed when the daemon exits.

  `calypso --berths` reads the same facts from the berth — `0600` in the user's
  own runtime directory — and remains the safer route for anything scripted.

- 5d131c8: A daemon's terminal stops repainting itself, and its attach addresses can be
  read back.

  `logo_animatePulse` starts a 100ms interval that saves the cursor, jumps up the
  screen, repaints the logo and restores — and it runs for as long as the process
  does. The interactive path stops it once boot finishes; the daemon path never
  did. So a daemon's terminal was being rewritten ten times a second forever,
  which made the banner it had just printed — the URLs and the attach token, the
  only thing anyone needs from that terminal — impossible to select.

  `calypso --berths` prints how to attach to every live daemon: the ARGUS link
  and the ready-to-paste `chell --remote --attach` command, per identity.

  The facts are read from the berth rather than copied to a more convenient
  place. A berth already holds the url and token at mode `0600` in the user's
  runtime directory; `/tmp` would be easier to reach and is world-readable, and
  the token is a credential.

- 0adb4f2: The daemon terminal gets a resting state: the console face.

  The boot-phase brain animation repainted by cursor arithmetic against a
  scrolling buffer — counting rows printed beneath it and jumping up — so a
  retry warning landing mid-frame interleaved with the art, and the pulse had
  to kill itself the moment output scrolled the logo away: the brain went
  silent exactly when the daemon came alive.

  Boot is unchanged and text-first: the brain prints, pulses while
  credentials are checked, and every address and token scrolls into ordinary
  scrollback. What is new is what happens when boot completes on a TTY: the
  daemon switches to the alternate screen buffer — the same screen vim and
  htop own — where the brain pulses forever at fixed coordinates over an
  identity panel (identity, wire, ARGUS URL, token, berth, attach line,
  uptime, attached surfaces, index counts), with the last few log lines caged
  in a dim strip beneath. The pulse is honest: idle is a slow shimmer, an
  executing command quickens it, a surface attaching flares it.

  Esc or `q` drops to the normal buffer, restored byte-perfect with the boot
  log intact and the lines captured while the face was up flushed beneath it;
  any key returns. Ctrl-C stops the daemon from either mode. Off a TTY
  (systemd, nohup) nothing changes: sequential logging, as before.

  The brain art and its frame renderer moved from chell to brasa
  (`logo_frameRender`, `logo_linesRender`, and the new `logoRows_count` /
  `logoColumns_count`), so any surface can draw it; chell keeps only its
  boot-terminal animation host. `daemon_launch` now returns the launched
  daemon's addresses and handle, which both launch paths (`chell --daemon`
  and the standalone `calypso` binary) feed to the face.

- a3bd3e9: The console face now covers the whole daemon boot, in two phases.

  From warm-up on, the alternate screen shows the brain in a frenetic boot
  pulse over a tall strip of the streaming boot log — the messages are the
  point while the machine comes up. When the daemon is listening, the same
  screen settles in place into the steady instrument: calm ambient pulse,
  identity panel, live telemetry, and the closing hint "HIT ESC TO TOGGLE
  THE BOOT LOG". Esc toggles to the raw text log in either phase; any key
  returns.

  Along the way: the log ring now treats a carriage return as a redraw, so a
  spinner's thousand frames stay one line; the face steps aside
  (`face_suspend`/`face_resume`) when warm-up failure asks the operator a
  question, so the prompt's readline owns the terminal; and a boot dying with
  the face up flushes the ring — the abort reason included — into the normal
  buffer instead of vanishing with it. New calypso API: `face_boot`,
  `face_ready`, `face_suspend`, `face_resume`.

- 9ed68cd: `download` no longer writes to the daemon host's disk. File delivery is now a
  surface capability, like prompting, piping and editing already were.

  The builtin resolved its destination with `path.resolve()` inside the engine,
  so the bytes landed on whatever machine hosted the engine. For a local shell
  that is right — the engine is in-process and the operator's disk is the
  engine's disk. Under a daemon it put files on a machine nobody attending the
  session was sitting at, and from a browser the question "download to where?"
  had no answer at all.

  `Surface` gains `fileDeliver`, and `SurfaceCapabilities` gains `fileDelivery`
  alongside `engineFilesystem` — which says whether a path the engine resolves is
  a path this surface's operator can open. Only an in-process local shell claims
  it. When it is false, `download` hands the file to the surface, which puts it
  somewhere its operator can actually reach: the client's disk for
  `chell --remote`, the download manager for `argus`.

  Only the request crosses the wire. Each surface fetches the bytes itself
  through the daemon's existing token-gated `/vfs` route, so a DICOM series is
  not base64'd across a channel meant for session state — the intent travels
  through the vocabulary and the bytes travel through the byte route.

  The local path is unchanged: a local `chell` still uses the existing transfer
  machinery, with its globs, directory walks and progress reporting.

  A directory has no bytes to hand over, and what to do about that depends on
  what the surface has — a third capability, `localFilesystem`, declared in the
  attach handshake and answered by the surface rather than by the daemon. A shell
  owns a filesystem wherever it runs, so `chell --remote` receives the tree file
  by file and gets the folder it asked for. A browser owns no directory and can
  take files only one at a time, so several hundred DICOM instances would be
  several hundred saves; for that surface alone a directory is archived into a
  single CUBE file first, through
  the registered `zip v20240311` pipeline — `pl-dircopy` into a zip plugin, the
  same mechanism the ChRIS web UI has used for years, but living in `brasa` where
  every surface reaches one implementation instead of each client re-deriving the
  sequence. `CHRIS_ARCHIVE_PIPELINE` names a different pipeline where a
  deployment registered one. When it is absent, the failure says which pipeline
  is missing and that it can be registered from the store.

  The archive run announces itself rather than creating a feed silently, because
  it is a workaround for CUBE having no directory-archive route: issue #233.

  `upload` has the mirror problem — it reads from the engine host's disk — and is
  not addressed here, because the browser direction needs a file picker. See
  issue #232.

- 790f994: Instrument traffic stays off the session bus.

  A surface's internal commands — a panel's silent listing refresh, an ambient
  cycler's pipeline renders — are not things the operator said, yet they were
  broadcast to sibling surfaces and retained in scrollback, so a second
  attached console printed them live and every reattach replayed them as
  noise. The execute message gains an optional `instrument` flag: the daemon
  runs the command normally but skips the bus publish and the scrollback
  entry, so siblings and replays carry only operator activity.

- e58bf58: The wire contract moves out of `calypso` into a package of its own,
  `@fnndsc/menu`.

  A surface author should depend on the contract, not on the daemon that happens
  to serve it. Until now the contract was a subpath of `@fnndsc/calypso`, so a
  third-party surface took a dependency on the session host to learn the shape of
  a result. `menu` imports nothing from the stack and sits below `cumin`, so both
  the engine that produces envelopes and the browser that renders them can load
  it.

  Two vocabularies the contract narrows to moved with it, because they were
  declared above the thing that describes them: the structured-progress values
  (previously `@fnndsc/brasa/progress`) and the prompt-facing process-index state
  (previously `@fnndsc/cumin/proc-prompt`). Both are re-exported from their old
  homes, so existing importers are unaffected; `@fnndsc/cumin/proc-prompt` as a
  subpath is gone, and its types are available from `@fnndsc/cumin` directly.

  `CommandEnvelope` is now inferred from the schema that validates it. The engine
  and the wire previously carried separate declarations of the same shape, tied
  together by a compile-time assertion that one stayed assignable to the other; a
  single inferred type makes that drift impossible rather than detected.
  `@fnndsc/cumin` re-exports the name, so nothing that imports it changes.

  `@fnndsc/calypso/protocol` no longer exists as a subpath. Import
  `@fnndsc/menu`. The names remain re-exported from `@fnndsc/calypso` itself for
  now, since most of the stack has always reached them there.

  This is the scaffold for envelope Phase-2 — a typed result model for every
  command — recorded in `docs/menu.adoc`. `menu` itself is unpublished until that
  work lands, so thirty payload shapes can settle without forcing a release each
  time.

- 28b9a9f: Regard: the session learns what the operator is indicating.

  The wire contract gains one message, `regard`, travelling both directions
  under one shape: a surface reports the addressable thing the operator most
  recently indicated (a file clicked in a browser, a DAG node selected), and
  the daemon retains it as session truth — last write wins — mirrors it into
  the engine, and rebroadcasts it to every attached surface. A late attacher
  receives the retained value with its ack, so spawn-then-see workflows start
  seeing immediately.

  The value is an address in the namespace plus the model kind it was
  indicated through, never view-space coordinates: what has no address is view
  state and stays surface-side. The brasa session retains the value behind
  `regard_get`/`regard_set`, so engine-side consumers can answer "what is the
  operator regarding" without any surface geometry crossing the seam. Design
  record: apps/argus/docs/aegis.adoc.

- 8842ab4: Indeterminate progress now crosses the daemon wire as typed facts rather than
  terminal escapes.

  The spinner used to write `\r\x1b[K<frame>` and cursor hide/show to the status
  channel twelve times a second, so every attached surface received terminal
  choreography whether or not it was a terminal — a web surface had to emulate a
  character grid to recover the meaning, and got it subtly wrong. It now announces
  `operation: 'task'`, `kind: 'inspection'`, `phase: 'working'` with a label, and
  closes with `phase: 'complete'`. Each surface draws waiting in its own idiom.

  Only state changes cross the wire: frames and elapsed counters are the
  renderer's, so a spin of any length costs two events instead of dozens per
  second. `chell` gained the elapsed counter its spinner used to bake into the
  label, and `argus` gained a full progress renderer — indeterminate work spins,
  counted work fills a bar — which also surfaces the download progress it had
  been silently discarding.

  The `operation` and `phase` enums gained `task` and `working`. Every enum on
  the progress message now degrades on an unknown value instead of failing the
  parse and dropping the message whole: `operation` to `task`, `phase` to
  `working`, `status` to `unknown`, `kind` and `unit` to absent. That makes good
  the contract's promise that change within a major is additive — for future
  additions, since the fallback lives in the build doing the reading.

  The spinner keeps its call signature, so its callers are unchanged. Its
  `showTiming` and `clearLine` arguments are now ignored: both are rendering
  decisions. It also no longer inspects `process.stdout.isTTY` before announcing,
  which had suppressed progress inside the daemon, where the engine's own stdout
  is never a terminal but the attached surface may well be able to draw.

### Patch Changes

- 19a4d5b: The daemon boot experience, settled: classic boot, minimal face.

  Booting is the classic in-scroll experience again — the brain lights up at
  connect and the boot log with its in-stage progress scrolls beneath it
  (frames now paint as one buffered write, so concurrent log lines cannot
  tear the art). When the daemon is ready, the boot screen is replaced by a
  minimal console face on the alternate buffer: the animating brain,
  vertically centered, one status line (DAEMON RUNNING · SESSION ESTABLISHED,
  or ENGINE EXECUTING while a command runs), and the Esc hint. Nothing else.
  Esc shows the verbatim text record — boot log, addresses, token — which the
  ready handoff now halts the pulse without repainting, so it can never again
  be stamped over; any key returns to the brain.

- 976c753: `chell --remote` can attach to a daemon on another machine.

  `CALYPSO_BIND` has always opened the wire to the network, and the attach token
  has always gated the session — but _discovery_ is local. A berth is a file in
  one host's runtime directory, so a surface on another machine has none to read,
  and the berth recorded `ws://127.0.0.1:<port>` regardless of what the daemon
  bound. The wire was reachable and nothing could tell a remote `chell` where to
  point: a browser could attach and a terminal could not.

  `--attach` takes an explicit address and skips discovery:

  ```
  chell --remote --attach http://pangea:41234/?token=abc123
  ```

  The address is the one the daemon prints. The web surface and the wire share a
  port, so the ARGUS link names both and pasting it is the whole interaction;
  `--token` supplies the token separately where an address carries none, and
  `https`/`wss` are preserved. The berth is built in memory and never written,
  since another machine's daemon does not belong in this machine's berth
  directory.

  A daemon bound to anything but loopback now records a routable URL in its own
  berth and prints the ready-to-paste attach command beside the ARGUS link.

  This is not the `porter` server. There is no listener beyond the one
  `CALYPSO_BIND` already opened, no cross-host auth beyond the attach token, and
  no way to discover a daemon you were not told about.

- bf09355: The telemetry heartbeat now refreshes the promptline while the process index moves: warm-up progress reaches idle surfaces without waiting for a command, and the prompt settles when reconciliation completes.
- Updated dependencies [1d600ac]
- Updated dependencies [0adb4f2]
- Updated dependencies [31c2a50]
- Updated dependencies [1c195a7]
- Updated dependencies [9ed68cd]
- Updated dependencies [e58bf58]
- Updated dependencies [e062dbf]
- Updated dependencies [87f7c59]
- Updated dependencies [3125517]
- Updated dependencies [28b9a9f]
- Updated dependencies [8842ab4]
- Updated dependencies [b39b584]
  - @fnndsc/brasa@0.13.0
  - @fnndsc/cumin@3.15.0

## 0.6.1

### Patch Changes

- 07ae801: The daemon now finds the argus bundle relative to its own module location, not only the working directory. A dev-tree `chell --daemon` launched from anywhere serves the web surface; previously it silently served nothing unless the daemon was started from the checkout root or `CALYPSO_WEB_ROOT` was set by hand.

## 0.6.0

### Minor Changes

- 0ad04f2: The engine can now hand raw file bytes to a hosting daemon: brasa's `BrasaEngine` gains an optional `file_read(filePath)` that resolves a ChRIS VFS path to a `Buffer` through chili's binary cat. Calypso's daemon exposes it as a token-gated `/vfs?path=&token=` HTTP route with extension-derived content types, letting a web surface render images and other binary content that a text transcript cannot carry.
- 1928d4b: The daemon now rides an explicit HTTP server: WebSocket upgrades carry the session contract unchanged, and plain GETs serve a configured static web root (the built ARGUS surface), discovered from `CALYPSO_WEB_ROOT` or a monorepo checkout's `apps/argus/dist`. The launcher prints the browser URL with the attach token. A new `@fnndsc/calypso/protocol` subpath exports the browser-safe wire contract (schemas, validation, version) without server-side dependencies.

### Patch Changes

- Updated dependencies [0ad04f2]
  - @fnndsc/brasa@0.12.0

## 0.5.1

### Patch Changes

- Updated dependencies [14f8ee8]
- Updated dependencies [69b0617]
- Updated dependencies [7ed8e1c]
- Updated dependencies [7dc3bca]
  - @fnndsc/cumin@3.11.0
  - @fnndsc/brasa@0.11.0

## 0.5.0

### Minor Changes

- 67377a3: Unify the five correlation-id request/reply implementations onto one `RequestBroker`. The daemon's four surface-delegated brokers (prompt, pipeline segment, host shell, edit) and the remote client's own pending-request map previously each reimplemented the id/pending/close lifecycle with divergent correctness; all five now share one class that uniformly guarantees origin-validated settles (no surface can answer another surface's prompt), close-listener removal on settle (no per-request listener leak), and rejection when the origin disconnects. The protocol gains optional `promptError` and `editError` messages (additive, no version bump) so a surface can report a failed or impossible prompt or edit. Behavior change on the remote surface: a client without a prompt, pipe, or edit handler now reports the inability as an error instead of silently answering empty, passing pipe input through unchanged, or returning an unchanged "successful" edit.
- b2f5ad3: Greet every surface with the stack's identity. Builds now record the short git hash they were produced from (`dist/buildinfo.json`, written by the new `scripts/buildinfo.mjs` build step), and brasa exposes it through `buildHash_get` alongside `welcomeLine_build`/`welcomeLine_compose`, which render a banner of the form `ChELL Executes Layered Logic, v 5.3.0 (886f09). Welcome.` An interactive chell session prints the banner and a short fortune at boot, the calypso daemon announces its banner plus an aligned version line for every stack layer (chell, brasa, chili, salsa, cumin, calypso) when it starts listening, and the attach handshake gains an optional `stack` field carrying all six versions and the build hash, so a remote surface banners the daemon's full reported stack rather than its local install's. `fortune_random` is exported for reuse, with an optional line-count bound so banners favour short cookies.

### Patch Changes

- 8ec8a4b: Add explicit, command-scoped CUBE elevation with `sudo <command>`. The active surface collects an administrator identity and hidden password; a temporary CUBE client runs only the nested command, then the normal session is restored. Group membership and plugin registration now suggest a copyable `sudo` rerun after an authorization failure, and plugin registration no longer owns a separate interactive admin prompt.
- d0ac04f: Preserve failure causes and tighten cache contracts. Errors that were replaced by generic messages now carry their real cause: controller and handler creation failures name the underlying error instead of "no ChRIS context", `cat` shows the actual fetch failure, docker command failures surface stderr detail, context-set errors actually print, settings load/save failures are announced instead of silently using defaults or losing changes, unreadable berth and discovery files are named instead of reading as "no daemon", token-file read errors are distinguished from the logged-out state, and resource deletes report why they failed. Every remaining deliberate error absorption now carries a dated adjudication comment. Cache contracts: the PACS provider's decoded-query cache caches settled results only and is size-bounded; the object-context factory gains an eviction hook (`objContext_evict`) for deleted plugin or feed ids; `mv` and `cp` invalidate the whole affected listing subtree; and a new PACS query invalidates the cached `/net/pacs/queries` listing so it appears in the next `ls` immediately.
- 3cde784: Publish refreshed prompt context before completing a remote command so
  state-changing commands cannot leave ChELL displaying a stale prompt.
- ac69b3e: Run ChELL shell escapes on the originating surface, including remote clients,
  instead of exposing the CALYPSO daemon host process and filesystem.
- Updated dependencies [2e60785]
- Updated dependencies [66bc932]
- Updated dependencies [8ec8a4b]
- Updated dependencies [d0ac04f]
- Updated dependencies [886f09c]
- Updated dependencies [50e9bb1]
- Updated dependencies [d0ac04f]
- Updated dependencies [22db63f]
- Updated dependencies [ac69b3e]
- Updated dependencies [0e92d4d]
- Updated dependencies [590a943]
- Updated dependencies [fa81126]
- Updated dependencies [b2f5ad3]
  - @fnndsc/brasa@0.10.0
  - @fnndsc/cumin@3.9.0

## 0.4.5

### Patch Changes

- Carry semantic Pipeline-inspection progress from a hosted Brasa engine to
  the remote surface that issued the command.
- Updated dependencies
  - @fnndsc/brasa@0.9.8

## 0.4.4

### Patch Changes

- Carry cold, cached-refresh, and failed `/proc` lifecycle state through the
  CALYPSO prompt contract; reorder p10k segments and render distinct lifecycle
  clues for local and remote surfaces.
- Updated dependencies
  - @fnndsc/cumin@3.8.2
  - @fnndsc/brasa@0.9.3

## 0.4.3

### Patch Changes

- 6f0833a: Release the coordinated ChELL stack with deterministic `/proc` topology progress, complete visible-feed indexing, safe warm-up query gating, remote one-shot command completion, and refreshed daemon documentation.
- Updated dependencies [6f0833a]
  - @fnndsc/cumin@3.8.1
  - @fnndsc/brasa@0.9.2

## 0.4.2

### Patch Changes

- 71a6cd4: Route a pipeline executable's bare `--signalflow` flag to SignalFlow diagram output and provide contextual help for dynamic pipeline commands. Keep final-segment redirection on the originating surface, propagate remote pipe-segment failures back to the engine, and prevent remote command errors from terminating the interactive ChELL client. Daemon mode now reports shared startup cache warming and publishes its listening berth only after engine readiness. Consistently document `signalflow -` for stdin rendering.
- Updated dependencies [71a6cd4]
  - @fnndsc/brasa@0.9.1

## 0.4.1

### Patch Changes

- Updated dependencies [e630f79]
- Updated dependencies [e630f79]
  - @fnndsc/brasa@0.9.0
  - @fnndsc/cumin@3.8.0

## 0.4.0

### Minor Changes

- 50d0680: Run several CALYPSO daemons on one machine — one per CUBE identity — driven by the
  same `--daemon` / `--remote` verbs:

  ```
  chell --daemon me@https://cube/api/v1/ -p pw       # my daemon
  chell --daemon them@https://cube/api/v1/ -p pw     # their daemon (isolated)
  chell --remote me@https://cube/api/v1/             # attach to MY daemon
  chell --remote                                     # sole berth attaches; picker if several
  ```

  Daemon discovery is now keyed by identity: each daemon advertises a **berth**
  (`{ identity, url, token }`) under `$XDG_RUNTIME_DIR/calypso/` (falling back to the
  system temp dir), `0700` on the directory and `0600` on each file. `--daemon` refuses
  to start a second daemon for an identity that is already live, pointing at the
  running one instead. Bare `--remote` attaches the sole live berth, offers an
  interactive picker when several are running, and requires an explicit
  `<user>@<url>` in a non-interactive context.

  All berth lookup goes through a `BerthResolver` seam (`resolve`, `list`), with a
  `LocalBerthResolver` over the runtime files and an injected liveness probe that
  reaps berths whose daemon has gone. The seam leaves room for a future network
  resolver without any surface change.

## 0.3.7

### Patch Changes

- Updated dependencies [8ac7ef9]
  - @fnndsc/brasa@0.8.0

## 0.3.6

### Patch Changes

- Updated dependencies [a1f6694]
- Updated dependencies [01ab743]
- Updated dependencies [b8ae635]
- Updated dependencies [ca63e8b]
  - @fnndsc/cumin@3.7.0
  - @fnndsc/brasa@0.7.0

## 0.3.5

### Patch Changes

- Updated dependencies [e5a30f7]
  - @fnndsc/brasa@0.6.0

## 0.3.4

### Patch Changes

- Updated dependencies [c2087d0]
  - @fnndsc/brasa@0.5.0

## 0.3.3

### Patch Changes

- Updated dependencies [512e14f]
- Updated dependencies [880d37a]
- Updated dependencies [e43f42a]
  - @fnndsc/brasa@0.4.0

## 0.3.2

### Patch Changes

- Updated dependencies [a0d3df5]
  - @fnndsc/brasa@0.3.0

## 0.3.1

### Patch Changes

- Updated dependencies [d69b086]
  - @fnndsc/brasa@0.2.0

## 0.3.0

### Minor Changes

- c824000: calypso is now a self-contained session daemon. It gains the `calypso` binary (create a brasa engine, restore a saved session, host it over WebSocket) and depends on the new `@fnndsc/brasa` engine package.

  Breaking (allowed under 0.x): the package is now ESM-only (was CommonJS), and the `promptline` wire message carries a prompt `context` for the surface to theme, rather than a pre-rendered `text` string.

## 0.2.0

### Minor Changes

- f8e0233: Add the CALYPSO daemon: a WebSocket host over one engine. `CalypsoDaemon` binds the loopback interface only and hosts a single engine, which it accepts through a structural `HostedEngine` interface (chell's `ChellEngine` satisfies it) rather than importing chell — keeping calypso engine-agnostic and free of a package cycle. A surface attaches with the contract version and a random attach token (generated at startup, written to a user-readable 0600 file for same-user discovery, compared in constant time via `timingSafeEqual`); once attached it drives the engine with `execute` and `complete` messages and receives `result` and completion replies, with execution serialized per connection. CUBE credentials never cross the wire — the hosted engine holds its own session. This slice returns each command's final result envelopes; live output streaming and the cross-surface session bus build on it.
- 30a3e1e: Interactivity over the wire: a builtin that prompts during a remote command now reaches the surface running it. The contract gains a `prompt` request (daemon→surface, with hidden-input support) and a `promptAnswer` reply (surface→daemon). The daemon serializes execution across the whole session so a mid-command prompt has one unambiguous target, and exposes an input broker (`prompt_current`) the host wires into its `Surface`; the `chell --daemon` launcher installs a surface whose `prompt` delegates to it, so `repl_question` (passwords, confirmations, the plugin admin flow, the prompt configurator) works over the wire unchanged. The `chell --remote` client answers incoming prompt requests from its own terminal (hidden when asked) and replies. Completion already round-trips from the earlier daemon work; the themed pushed prompt string and client-side pipe-segment execution remain follow-ups.
- 93e604f: Run pipeline segments on the surface, never on the daemon host. Segment execution becomes a surface capability: the `Surface` gains `pipeSegments` (a capability flag) and a `pipeSegment(command, input)` method. The local CLI runs segments in-process exactly as before (byte-identical); the daemon's surface routes them over the wire (new `pipe`/`pipeResult` messages, base64 for the bytes) to the surface running the command, which runs them on its own machine — so a pipeline like `ls | grep foo` never spawns anything on the daemon host, closing that attack surface. A surface without the capability (a browser) fails such pipelines with a clear message. Completes the interactivity work: prompts, completion, the pushed prompt string, and pipe segments all now work over the wire.
- f492dd9: Push the themed prompt string to remote surfaces. Only the daemon holds the session context the prompt renders, so it renders the prompt and pushes it (a new `promptline` message) to every surface on attach and after each command — the context may have changed. A surface prints what it receives, so prompt themes look identical whether the session is local or remote. chell factors prompt rendering into a shared `sessionPrompt_render` used by both the local REPL and the daemon's `promptProvider`; the `chell --remote` client renders the latest pushed prompt (falling back to a fixed string until the first push), replacing the placeholder prompt it showed before.
- 7cee888: The surface owns the local editor, so `edit` works over the wire. The `Surface` gains a `localEdit(content, extension)` method (resolving the flag-only deferral from the prompt-capability work): the CLI surface backs it with the temp-file-and-`$EDITOR` mechanics that used to live in the `edit` builtin, and the daemon backs it by routing to the surface running the command (new `edit`/`editResult` messages + an `edit_current` broker) so the operator's own editor opens, never one on the daemon host. The `edit` builtin no longer touches processes or temp files for editing — it fetches the file, hands the content to `surface.localEdit`, and uploads the result; `chell --remote` opens the client's editor. A surface without the `localEdit` capability (a browser) fails `edit` with a clear message.
- e293d97: Add the session bus to the daemon. All attached surfaces share one session: each command's result envelopes are broadcast to the _other_ attached surfaces as `session {surface, envelope}` events (tagged with the surface that produced them), so a command issued in one surface is immediately visible in the rest — the originator receives its own correlated `result`, not a duplicate broadcast. A bounded scrollback ring buffer (default 200 envelopes, configurable via `scrollbackSize`) is replayed to an attaching surface so it does not join blind; scrollback is presentation rather than truth, so a daemon restart correctly loses it. Surfaces are dropped from the bus when their socket closes.
- 38df08f: Introduce `@fnndsc/calypso`, the fifth mise package: the session daemon that will host the chell engine and serve it to surfaces over a WebSocket. This first slice is the wire contract — the typed protocol schemas and boundary validation every message crosses. Messages are two direction-keyed discriminated unions (surface→daemon: attach/execute/complete; daemon→surface: attached/result/complete/output/session/error), defined as zod schemas that are the single source of truth and from which the message types are inferred. A `commandEnvelopeSchema` validates cumin's `CommandEnvelope` on the wire, kept in step with cumin's type by a compile-time guard so the contract cannot silently drift. Boundary validation rejects structural violations, tolerates unknown additive fields, and never throws; the contract version is carried in the attach handshake and refused on mismatch. See docs/calypso.adoc for the governing design.

### Patch Changes

- Updated dependencies [aa81b0a]
- Updated dependencies [2099ff6]
- Updated dependencies [c47ff22]
  - @fnndsc/cumin@3.5.0
