# @fnndsc/chell

## 5.19.9

### Patch Changes

- Updated dependencies [f6790b6]
- Updated dependencies [f6790b6]
  - @fnndsc/argus@0.45.0
  - @fnndsc/menu@0.32.0
  - @fnndsc/brasa@0.51.2
  - @fnndsc/calypso@0.28.3
  - @fnndsc/chili@3.8.2
  - @fnndsc/cumin@3.29.5

## 5.19.8

### Patch Changes

- Updated dependencies [ac966ce]
- Updated dependencies [0ee1344]
  - @fnndsc/argus@0.44.0
  - @fnndsc/brasa@0.51.1

## 5.19.7

### Patch Changes

- Updated dependencies [8fd7226]
- Updated dependencies [ec2d610]
- Updated dependencies [68d09fc]
- Updated dependencies [71f3c63]
  - @fnndsc/brasa@0.51.0
  - @fnndsc/calypso@0.28.2

## 5.19.6

### Patch Changes

- Updated dependencies [605879e]
  - @fnndsc/argus@0.43.0

## 5.19.5

### Patch Changes

- Updated dependencies [9a58e99]
  - @fnndsc/argus@0.42.0

## 5.19.4

### Patch Changes

- Updated dependencies [6323634]
- Updated dependencies [f086bc6]
- Updated dependencies [4568c64]
- Updated dependencies [4568c64]
- Updated dependencies [24c7433]
  - @fnndsc/argus@0.41.0
  - @fnndsc/calypso@0.28.1
  - @fnndsc/menu@0.31.1

## 5.19.3

### Patch Changes

- c742135: An identity that sees thousands of feeds can log in again: the boot no longer waits on CUBE's slow feed list (#1280). The token check reads `users/` instead of the API root, which is the feed list and took up to 22 s for `chris`; a CUBE that does not answer the check is said to be silent, never to have refused the token. Each client reads its root once for every caller, and feed-list pages wait 120 s instead of chrisapi's 30. A cold boot walks the feed index behind the listening daemon, as a restored one already did, so the session answers the door before its 120 s wait runs out; a `/proc` read that arrives first joins the walk instead of starting a second.
- Updated dependencies [c742135]
  - @fnndsc/cumin@3.29.4
  - @fnndsc/salsa@4.4.3
  - @fnndsc/brasa@0.50.1

## 5.19.2

### Patch Changes

- Updated dependencies [41769da]
- Updated dependencies [0efbb7c]
- Updated dependencies [7a10507]
- Updated dependencies [b8bc519]
- Updated dependencies [56debd5]
  - @fnndsc/brasa@0.50.0
  - @fnndsc/calypso@0.28.0
  - @fnndsc/menu@0.31.0
  - @fnndsc/argus@0.40.0
  - @fnndsc/chili@3.8.1
  - @fnndsc/cumin@3.29.3

## 5.19.1

### Patch Changes

- f8b07e0: A backslash inside single quotes is now just a backslash, as in any POSIX shell (#1258). `grep '\.mgz$'`, `find … -name '*\.nii'` and `printf '%s\n' a` reach their command with the backslash they were written with; before, the line dropped it, so a pattern meant "any character" where it said a dot.

  Quoting follows POSIX throughout: inside single quotes every character is literal; inside double quotes a backslash escapes only `$`, `` ` ``, `"`, `\` and newline (`"a\"b"` and `"\$HOME"` work as before) and stays before anything else (`"a\b"` keeps it); outside quotes it escapes the next character. The word parser and the `;`, `|`, `>` and `$( … )` splitters read one rule (`lib/quoting.ts`), so none of them splits a line its words read otherwise. A line that relied on `\'` inside single quotes, such as `'it\'s'`, now closes the quote there; write `"it's"` or `'it'\''s'`.

  ARGUS quotes the lines it writes (an EDIT save, a cohort's `gather add`, a tag) the same way: single quotes, with a single quote written `'\''`. Its old quoting doubled every backslash and wrote `\'`, which under these rules doubled a backslash on every save and refused text with an apostrophe.

- Updated dependencies [e9ea847]
- Updated dependencies [e12598c]
- Updated dependencies [f8b07e0]
- Updated dependencies [26df4e2]
  - @fnndsc/brasa@0.49.0
  - @fnndsc/salsa@4.4.2
  - @fnndsc/argus@0.39.2
  - @fnndsc/calypso@0.27.1

## 5.19.0

### Minor Changes

- 02c20bf: Every function name now says what it does: the 462 that put a preposition where the verb goes are renamed (#1227).

  The style guide names a function `<subject>[Qualifier]_<verb>[Adverb]`. Names such as `answerRows_of`, `seriesUID_ofPath`, `options_toParams` and `ask_onPane` put a preposition in the verb's place, which names the result without saying whether the function derives, parses, builds or renders it. They are now `answerRows_derive`, `seriesUID_parse`, `options_convertToParams` and `askOnPane_await`. A preposition may still qualify the verb (`x_readFromCache`) or the object (`askOnPane_await`); it may not start the method.

  `npm run lint:rpn` (`scripts/rpn-prepositions.mjs`) refuses a function, `const` function or underscored method whose method is, or starts with, `of`, `to`, `with`, `from`, `for`, `by`, `as`, `in`, `on` or `at`, and CI runs it. The exported names change with no aliases kept: nothing outside this repository imports them.

### Patch Changes

- Updated dependencies [f27596d]
- Updated dependencies [60c3017]
- Updated dependencies [fd1711f]
- Updated dependencies [68d496d]
- Updated dependencies [4bc9d87]
- Updated dependencies [5602a4f]
- Updated dependencies [c58c3a6]
- Updated dependencies [02c20bf]
- Updated dependencies [55e2041]
  - @fnndsc/argus@0.39.0
  - @fnndsc/menu@0.30.0
  - @fnndsc/brasa@0.48.0
  - @fnndsc/calypso@0.27.0
  - @fnndsc/chili@3.8.0
  - @fnndsc/cumin@3.29.0
  - @fnndsc/salsa@4.4.0

## 5.18.1

### Patch Changes

- 52b9691: Help and docs now say three things that surprised in use. A fan-out plugin's run ends once its jobs are submitted. A pattern given to grep matches a study's own text too, keeping that whole study. With a default door, `chell -c` and `-f` run in your shared session (#1228).
- Updated dependencies [e1d052d]
- Updated dependencies [b4cd618]
- Updated dependencies [6a766d2]
- Updated dependencies [52b9691]
- Updated dependencies [9c9ec38]
- Updated dependencies [a0fa450]
- Updated dependencies [682f713]
- Updated dependencies [a26fbd4]
- Updated dependencies [05ec948]
- Updated dependencies [dd0b518]
- Updated dependencies [d6cdb13]
- Updated dependencies [caff86a]
- Updated dependencies [46bc80d]
  - @fnndsc/brasa@0.47.0
  - @fnndsc/argus@0.38.0
  - @fnndsc/menu@0.29.0
  - @fnndsc/salsa@4.3.0
  - @fnndsc/calypso@0.26.2
  - @fnndsc/chili@3.7.16
  - @fnndsc/cumin@3.28.6

## 5.18.0

### Minor Changes

- 243aafa: The recent-state pronouns are gone: a line names what it made with `A=$(…)`, never `${feed}`, `${run}` or `${query}`. `${feed}`, `${run}`, `${run.place}` and `${query}` were filled behind the line by whatever ran last, so one name meant different runs on different lines and a path that forgot to fill one left it stale (#1207); they and `session/recent.ts` are removed. `plugin run` is retired (a plugin runs by its name, where the session stands), and so are `pull --plugin` and `--pipeline` (pull lands data; a run goes over it). `chell -f` and `chell file` play the script as a manifest: each line shown, the first refused line stops it, and the exit is non-zero; `-e` changes nothing for a script. `help pronouns` is now `help variables` (#1208).

### Patch Changes

- 38fbdc9: The docs say one thing about scripts: a script is a manifest, played by `play`, stopping at its first refused line. `execution.adoc` is now about invoking chell and points at `docs/manifest.adoc` for the language; the retired `pull --plugin`/`--pipeline` and `plugin run` are gone from the README, glossary, command reference and PACS design, which point at `gather process`; `pluginrun.adoc` says a run waits, how to name it with `A=$(…)`, and absorbs the old implementation summary; `posix.adoc` describes variables, the unified expander and what stays non-POSIX (#1208).
- Updated dependencies [f2180c1]
- Updated dependencies [c90b8a2]
- Updated dependencies [243aafa]
- Updated dependencies [0a52833]
  - @fnndsc/brasa@0.46.0
  - @fnndsc/argus@0.37.1
  - @fnndsc/calypso@0.26.1

## 5.17.0

### Minor Changes

- 49ccdfd: The prompt draws a backend's segments in the backend's order, and a long identity yields columns before the path does.

  A stratus session's prompt reads `OCI │ tenancy │ region │ user │ domain │ working directory`, in both themes, with the theme's own time, duration, status and question segments trailing. The user is the cloud's name for the identity in full, an e-mail address on a tenancy that names users so; when the line is tight it is truncated from the left, keeping its ending, so `whoami` and the prompt never disagree. A ChRIS prompt is unchanged.

### Patch Changes

- 0388f12: A stratus or null session greets cleanly: no red `motd` refusal on attach, and no ChRIS packages in its banner.

  The greeting asks `motd` with its output scoped away and prints only what `motd` answered, so a backend without one says nothing. A remote line's live output now goes to the sink it was sent from, not whichever is active when it arrives. The daemon's banner and attach answer name chili, salsa and cumin only for a ChRIS session (`versionsForBackend_of`).

- ca1ba5b: A terminal attaches to a stratus daemon by its identity (`chell --remote rudolph@fnndsc`), two-@ users included.

  The target is tried as typed before it is read as a CUBE URL, so a berth keyed by a cloud identity (`user@tenancy`) matches, and a user that is an e-mail address splits on the last `@`. `chris@cube.example.org` still finds the normalised `chris@http://cube.example.org` berth.

- 49501d4: The --host-control help now lists the tasks tier and says that a bare flag grants shell, files and pipes only.

  The attach banner now says what each tier hands the daemon, in the order the daemon gave them, so a daemon granted only `tasks` reads "jobs may change the cloud and bill" rather than claiming `!` and pipes run on its host.

- 540b477: A terminal attached to a stratus session greets with the Trusted Domain mark; the brain stays for ChRIS.

  `chell --remote` now draws its art after the attach answer, which names the session's backend: the brain for `chris` (and for a daemon that names none), the TD mark in its ring for `stratus`, nothing for another backend. The daemon console a stratus or calypso daemon opens on its own terminal is this same surface, so it greets the same way.

- Updated dependencies [9b0aabe]
- Updated dependencies [7c65644]
- Updated dependencies [0388f12]
- Updated dependencies [01fcb59]
- Updated dependencies [49ccdfd]
- Updated dependencies [49501d4]
- Updated dependencies [49501d4]
- Updated dependencies [49501d4]
- Updated dependencies [49501d4]
- Updated dependencies [14f8fc1]
- Updated dependencies [14f8fc1]
- Updated dependencies [2a5a921]
- Updated dependencies [49ccdfd]
- Updated dependencies [dcdc6cd]
  - @fnndsc/argus@0.37.0
  - @fnndsc/calypso@0.26.0
  - @fnndsc/brasa@0.45.0
  - @fnndsc/menu@0.28.0
  - @fnndsc/chili@3.7.15
  - @fnndsc/cumin@3.28.4

## 5.16.7

### Patch Changes

- Updated dependencies [49f23f3]
- Updated dependencies [2ea9a84]
- Updated dependencies [4e14d8e]
  - @fnndsc/argus@0.36.0

## 5.16.6

### Patch Changes

- Updated dependencies [747193f]
  - @fnndsc/argus@0.35.0

## 5.16.5

### Patch Changes

- Updated dependencies [779ccf9]
- Updated dependencies [5cdc0c8]
  - @fnndsc/argus@0.34.0

## 5.16.4

### Patch Changes

- 21649d1: A running command can show its surface a typed event, and trek shows its state at every Command: prompt.

  `OutputSink` gains `event_write(kind, data)`, the wire gains the `event` message (daemon to the command's origin surface, live only), and the ARGUS client hands events to its host. bsd-trek's `TrekTerminal` gains `state_show`, called with a deep copy of the whole game state before each command is asked for; the session's `trek` sends it as `games.trek.state`. The recorded C games replay unchanged; a terminal that only prints leaves `state_show` out. This is what a bridge that draws the game reads, instead of the printed scans.

- Updated dependencies [f42918a]
- Updated dependencies [21649d1]
- Updated dependencies [171bbe4]
  - @fnndsc/argus@0.33.0
  - @fnndsc/brasa@0.44.0
  - @fnndsc/menu@0.27.0
  - @fnndsc/calypso@0.25.0
  - @fnndsc/chili@3.7.13
  - @fnndsc/cumin@3.28.2

## 5.16.3

### Patch Changes

- Updated dependencies [d6337c6]
- Updated dependencies [057ae8e]
  - @fnndsc/cumin@3.28.1
  - @fnndsc/brasa@0.43.0
  - @fnndsc/calypso@0.24.3

## 5.16.2

### Patch Changes

- Updated dependencies [20cd854]
  - @fnndsc/cumin@3.28.0
  - @fnndsc/salsa@4.2.0
  - @fnndsc/brasa@0.42.0
  - @fnndsc/calypso@0.24.2

## 5.16.1

### Patch Changes

- Updated dependencies [e9d9540]
  - @fnndsc/salsa@4.1.0
  - @fnndsc/brasa@0.41.0
  - @fnndsc/chili@3.7.12
  - @fnndsc/cumin@3.27.20
  - @fnndsc/calypso@0.24.1

## 5.16.0

### Minor Changes

- c1ad144: Full-screen host programs such as vi, top or your own zsh now work in the ARGUS terminal when host control is on. `!cmd` typed there runs in the terminal's own pty, and Ctrl-C reaches it as an interrupt.
- 5dadfdd: The terminal console's text is the old console's size again, and a new clear command empties the console. The terminal had taken the page's larger size because xterm measured it before the console's styles applied. clear empties the screen and scrollback in a terminal and the record in the transcript; Ctrl-L still clears the screen alone.

### Patch Changes

- fb6813d: Any running command can now be stopped, with Ctrl-C or the console's new STOP capsule. A host process it started is killed, and a command that does not end when asked is abandoned after three seconds so the session is free again. A chell that disconnects stops its command, and Ctrl-C reaches a host program in the terminal.
- Updated dependencies [c1ad144]
- Updated dependencies [5dadfdd]
- Updated dependencies [c7acb1b]
- Updated dependencies [fb6813d]
  - @fnndsc/calypso@0.24.0
  - @fnndsc/argus@0.32.0
  - @fnndsc/brasa@0.40.0
  - @fnndsc/salsa@4.0.6
  - @fnndsc/menu@0.26.0
  - @fnndsc/chili@3.7.11
  - @fnndsc/cumin@3.27.19

## 5.15.0

### Minor Changes

- 66f1956: sl, cmatrix, rain, asciiquarium, tetris and snake play in the terminal they are typed in; --pane draws them in ARGUS's GAMES pane. The programs move to `@fnndsc/menu/games` so chell and ARGUS run the same ones; chell takes the screen (alternate screen, raw keys, the console's hues) and gives it back on q, Esc or Ctrl-C, and marks the console `playing` meanwhile. The transcript console, with no screen to play on, keeps the pane.

### Patch Changes

- 66f1956: A login whose token check gets no answer from CUBE asks once more before failing. If CUBE stays silent the session says CUBE did not answer, not that it refused the token.
- Updated dependencies [66f1956]
- Updated dependencies [66f1956]
  - @fnndsc/brasa@0.39.0
  - @fnndsc/menu@0.25.0
  - @fnndsc/argus@0.31.0
  - @fnndsc/calypso@0.23.1
  - @fnndsc/chili@3.7.10
  - @fnndsc/cumin@3.27.17

## 5.14.0

### Minor Changes

- 90b7688: The ARGUS console is now a terminal by default wherever the daemon offers one; TRANSCRIPT on its drawer goes back. A browser's terminal can no longer run anything on the daemon's host. Its chell used to declare that it could, so `!cmd`, host pipe segments, `edit` and `download` would have run on the daemon host. These requests now go to the browser that owns the terminal, which refuses `!` and host pipes by name, opens its own editor pane and saves downloads in the browser. Questions stay in the terminal. A terminal's chell marks for the page whether it is at its prompt, running a command or asking, and the page shows it as `data-terminal-state`. Ctrl-C at an open question now abandons it, so the command that asked is told and ends. Commands typed in the page's own terminal move the page as its console's commands always did: a game opens the GAMES pane, `say` speaks and a `cd` re-lists the files pane. An answered pane question is recorded in the terminal's scrollback. A line the terminal wrapped reads back as one line. The smoke suite drives either console (`SMOKE_CONSOLE=terminal|transcript`), and the nightly gains a transcript lane (#1125).
- 6bde343: ARGUS's own words now work from any chell on the session, including `desktop show`, `view runs` and `dag census on`. A browser declares the subjects its language claims (whole subjects such as `dag`, `desktop` and `pane`, and only listed verbs of shared ones such as `file open` and `help keys`). The daemon then routes a single command in a claimed subject to that browser instead of the engine, and the chell prints the browser's answer. The browser that owns a chell's terminal answers first, then the most recently active one. With no browser attached, a subject claimed whole is refused by name, and a shared subject stays the session's. Tab completion offers the claimed words. A browser can also send a note to its own consoles, printed above the line being typed. A terminal's chell now tells the daemon which terminal it draws. This is the groundwork for ARGUS's console becoming a terminal (#1125).

### Patch Changes

- Updated dependencies [90b7688]
- Updated dependencies [554fd24]
- Updated dependencies [90b7688]
- Updated dependencies [6bde343]
- Updated dependencies [7645d3c]
  - @fnndsc/argus@0.30.0
  - @fnndsc/calypso@0.23.0
  - @fnndsc/menu@0.24.0
  - @fnndsc/salsa@4.0.3
  - @fnndsc/brasa@0.38.1
  - @fnndsc/chili@3.7.9
  - @fnndsc/cumin@3.27.15

## 5.13.0

### Minor Changes

- 0820af7: Answers can be typed ahead, as in a terminal. A line typed while a command runs waits, and the command's next question takes it as the answer. If the command asks nothing, the line runs as the next command. Before, such a line went to the session as a command of its own, beside the one about to ask for it, so `terminate` then `n` without waiting lost the `n`. Ctrl-C forgets what was typed ahead, and a secret is never answered from it. Another surface's output now lands above the line being typed, and the prompt or open question is drawn again beneath it with what was typed so far (#1128).

### Patch Changes

- c73c81b: The daemon offers terminals: a browser's console can be a real chell, run under a pseudo-terminal. A surface sends `terminalOpen` with its size and receives the terminal's bytes as `terminalData`; it sends keystrokes back as `terminalInput`, and size changes as `terminalResize`. Each terminal is the same `chell --remote` a shell would run, attached back to this daemon over loopback. A terminal outlives the socket that opened it: opening it again by its id replays up to about 1 MB of recent output and carries on, even mid-command or mid-question. A terminal nobody is attached to closes after 15 minutes, and `exit` closes it at once. The pseudo-terminal comes from `node-pty` 1.1.0, an optional dependency compiled at install. A daemon where it did not build says `terminals: false` on attach and refuses `terminalOpen` with the reason. ARGUS's console moves onto this in the next release (#1125).
- 1a2a0d0: An open question shows across the session: `? N WAITING` on the ARGUS status strip, and `? N waiting` in chell's prompt. The daemon counts the questions open on every surface: they ride the heartbeat's lane (which surface asked what, and for how long) and every prompt context. ARGUS names each one in the strip's title and adds an ASKING row to the lane instrument; `who` says what each surface is waiting on. A question no longer freezes the session, so this is how a game paused in another tab, or a confirm left in a terminal, is not forgotten (#1128).
- Updated dependencies [7fefdbe]
- Updated dependencies [c73c81b]
- Updated dependencies [1a2a0d0]
- Updated dependencies [0746967]
- Updated dependencies [2ddbd41]
  - @fnndsc/argus@0.29.0
  - @fnndsc/calypso@0.22.0
  - @fnndsc/menu@0.23.0
  - @fnndsc/brasa@0.38.0
  - @fnndsc/chili@3.7.8
  - @fnndsc/cumin@3.27.14

## 5.12.6

### Patch Changes

- 6bee05a: A `chell -c` command's output is now only its answer, even when the session had to be started first. The session's start-up progress, and the notices that the daemon changed or disconnected, go to stderr, so a script or agent reading stdout no longer gets a boot log before the result.
- dac084d: Attaching with chell --remote now finds the session porter started for you. A script on the same machine can attach to it directly, with no door or token; before, `chell --remote` said "No live calypso" while your session was running. A daemon you start by hand is still allowed beside porter's.
- Updated dependencies [dac084d]
  - @fnndsc/calypso@0.21.4

## 5.12.5

### Patch Changes

- Updated dependencies [a44990a]
  - @fnndsc/brasa@0.37.0
  - @fnndsc/calypso@0.21.3

## 5.12.4

### Patch Changes

- 09c9a29: Logging out of a door no longer warns about a token that is already gone. When `chell auth logout` finds the door no longer knows the token (a newer login under the same name replaced it, or it was revoked), it says there is nothing to revoke. It no longer suggests revoking by name, which would have reached the newer login.
- Updated dependencies [e6b6ed8]
- Updated dependencies [a55f8db]
- Updated dependencies [b0b458b]
- Updated dependencies [739b2c5]
- Updated dependencies [79ac4a4]
- Updated dependencies [580af08]
  - @fnndsc/brasa@0.36.0
  - @fnndsc/calypso@0.21.2

## 5.12.3

### Patch Changes

- 6c310ee: chell now says which door it is using when a plain-http door is refused. A login to a second door that leaves an earlier one the default says so, with `--default` to switch. A refused door names itself, says when it is your default, and points at a door you are already logged into with `--insecure-door`.

## 5.12.2

### Patch Changes

- 4884a38: A door logged into with `--insecure-door` now works afterwards. The choice is kept with that door, so `chell -c '…'` uses it over plain http (saying so on each use) instead of refusing every command. Log in again with `--insecure-door` once to record it.
- Updated dependencies [216760d]
- Updated dependencies [6aa7bc6]
- Updated dependencies [d5a3b1c]
  - @fnndsc/argus@0.28.6

## 5.12.1

### Patch Changes

- Updated dependencies [3c8d56a]
- Updated dependencies [5102036]
- Updated dependencies [36cf130]
  - @fnndsc/calypso@0.21.0
  - @fnndsc/argus@0.28.4

## 5.12.0

### Minor Changes

- 0ac1bee: Nothing changes at the prompt: each command group brings its own help, and no backend can replace a core command (#981). The ChRIS commands' help (74 pages, and the resource contract they share) moves to `chris/help.ts` and registers with the ChRIS commands; the core's stays in `builtins/help.ts`. `/usr/bin` and command completion offer only verbs the session can run, as `help` does. `commands_register(group, 'backend')` refuses a group that names a core command; the package entry registers ChRIS that way. The hand-kept `command-keys.ts` goes, and with it the `COMMAND_HANDLERS_KEYS` export of brasa and chell; the registry answers instead.

### Patch Changes

- 43000d3: Nothing changes at the prompt: a daemon's berth name comes from its backend's account of who the session is (#982). The descriptor gains `session.identity_get()`, which returns a `SessionIdentity` (`user`, `where`, `connected`). For ChRIS that is the CUBE user at the CUBE URL, or `disconnected@no-cube` with no login, so every berth name, key and attach hint is the same as before. Each backend names its own disconnected session, so two backends never share one. calypso's launch reads the identity there and no longer imports cumin. chell keeps its folder, query and job checkpoints under the same name, through the backend. `identity_forSession` and `DISCONNECTED_IDENTITY` stay exported from calypso.
- b9a83f1: Nothing changes in the browser: calypso no longer depends on ARGUS, and the launcher passes the web root (#984). `daemon_launch` takes `webRoot`; `CALYPSO_WEB_ROOT`, a bundle under the working directory and the enclosing checkout still come first. chell depends on `@fnndsc/argus` and passes the bundle it ships (porter launches through chell). The `calypso` command still defaults to ARGUS when it is installed beside it. `packageWebRoot_find(name, from)` finds the bundle any installed package ships.
- Updated dependencies [be5f8b3]
- Updated dependencies [3060fa1]
- Updated dependencies [5afa298]
- Updated dependencies [cd68355]
- Updated dependencies [322606e]
- Updated dependencies [a0b567f]
- Updated dependencies [639b840]
- Updated dependencies [6268376]
- Updated dependencies [183aa7d]
- Updated dependencies [43000d3]
- Updated dependencies [e1085af]
- Updated dependencies [27ce9b8]
- Updated dependencies [7e2fc05]
- Updated dependencies [4431568]
- Updated dependencies [b9a83f1]
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
- Updated dependencies [012b966]
- Updated dependencies [0d3cf0b]
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
- Updated dependencies [f6171f7]
- Updated dependencies [11853c6]
- Updated dependencies [6752575]
- Updated dependencies [60cb7f8]
- Updated dependencies [0fe1e18]
- Updated dependencies [e1215ef]
- Updated dependencies [1681476]
  - @fnndsc/argus@0.28.0
  - @fnndsc/calypso@0.20.0
  - @fnndsc/menu@0.22.0
  - @fnndsc/brasa@0.35.0
  - @fnndsc/salsa@4.0.0
  - @fnndsc/chili@3.7.6
  - @fnndsc/cumin@3.27.11

## 5.11.4

### Patch Changes

- 8d15909: Nothing changes for chell, ARGUS or porter users: the engine's output and surface contract now lives in menu. `OutputSink`, `Surface` and their companions are served as `@fnndsc/menu/surface`; brasa re-exports them, and the engine installs its own sink and surface. `BrasaEngine` gains required `sink_install` and `surface_install`, so code that implements it must add both.
- Updated dependencies [8d15909]
  - @fnndsc/menu@0.21.0
  - @fnndsc/brasa@0.34.0
  - @fnndsc/calypso@0.19.10
  - @fnndsc/chili@3.7.5
  - @fnndsc/cumin@3.27.10

## 5.11.3

### Patch Changes

- 5bb17f6: Nothing changes for chell, ARGUS or porter users: a listing entry's shape now belongs to menu, with an open type. `ListingItem` and `listingItemSchema` are menu's, so a backend can list its own kinds beside `dir`, `file`, `link` and `vfs`; fond's `VFSItem.type` opens the same way, and chili re-exports the type.
- Updated dependencies [e1deb53]
- Updated dependencies [5bb17f6]
  - @fnndsc/salsa@3.21.2
  - @fnndsc/menu@0.20.0
  - @fnndsc/chili@3.7.4
  - @fnndsc/brasa@0.33.4
  - @fnndsc/cumin@3.27.9
  - @fnndsc/calypso@0.19.9

## 5.11.2

### Patch Changes

- d3618fb: chell installed from npm no longer prints "Could not load color config" before listings. chili's package now carries `config/colors.yml`, and a missing color file is reported once per process instead of on every call.
- df34da0: A failed login now says what failed, instead of always blaming the credentials. An untrusted TLS certificate names the host, the code and `NODE_EXTRA_CA_CERTS`; an unreachable CUBE says so with the code; only CUBE refusing the login mentions the password. The same holds for token logins, `sudo`, and porter's login page.
- Updated dependencies [d3618fb]
- Updated dependencies [df34da0]
  - @fnndsc/chili@3.7.2
  - @fnndsc/cumin@3.27.7
  - @fnndsc/calypso@0.19.7

## 5.11.1

### Patch Changes

- 6325bc4: Logging in from a terminal now works the way GitHub's does. `chell auth login` shows a one-time code and a plain door address (`…/device`) where you enter it while logging in, and it is recognised even behind a host wrapper that puts `--remote --door` in front of every call, which on titan had turned it into a plain door login. A host can name its door for everyone with `CHELL_DOOR`; a user's own default still wins.

## 5.11.0

### Minor Changes

- b4a7674: Log in at a porter once and let scripts through after, the way `gh auth login` works. `chell auth login` keeps a door token: by default a one-time code entered on the door's login page from any device, so the password never crosses the terminal; `--with-password` types it here for a door no browser can reach; `--with-token` pastes a token minted elsewhere. The token lives in `~/.config/chell/doors/<door-host>.json` at mode 0600 and is refused by name when the file is loose. `chell auth status`, `logout`, `token` and `tokens` round it out, and `chell --remote --door` uses the token when it has one, never over plain http to another host.
- 8ae54c6: After `chell auth login`, a bare `chell` or a `chell -c "…"` goes through that door with no flags. That is how `gh` reaches GitHub once logged in; `--no-door` asks for the local chell anyway, and a `user@url` target still names a CUBE directly. `-e` now holds through a door too: the line runs a segment at a time and stops at the first whose answer is an error. A token within a week of its death is said so on every call; one past it is refused with the words to run.

### Patch Changes

- eea6238: Coming through a door, `chell --remote --door` shows the session's boot rows as they happen. The client read the boot stream whole, so it waited for the door to close it and printed a minute of rows in one lump after "the boot as it happens:" had promised otherwise.

## 5.10.5

### Patch Changes

- d988570: The boot's Jobs row says when a /proc checkpoint was there and refused, and why, instead of reading like a first boot; a restore that left out a torn shard names how many feeds walk again.
- Updated dependencies [d988570]
  - @fnndsc/cumin@3.27.6

## 5.10.4

### Patch Changes

- d7688f9: A terminal now says when the calypso daemon it is attached to is out of date. The line comes at attach and the moment the daemon's code on disk changes, with the cure and what the newer release brings; before, only ARGUS said it, and a terminal through a porter door onto a day-old daemon saw an old kernel with nothing to explain why.

## 5.10.3

### Patch Changes

- 5a0eef5: The package ships its release notes, so a session can say what changed. They are read from CHANGELOG.md at build into dist/notes.json.
- Updated dependencies [5a0eef5]
- Updated dependencies [5a0eef5]
- Updated dependencies [5a0eef5]
  - @fnndsc/calypso@0.19.4
  - @fnndsc/brasa@0.33.0
  - @fnndsc/menu@0.19.0
  - @fnndsc/cumin@3.27.5

## 5.10.2

### Patch Changes

- Updated dependencies [6901a81]
- Updated dependencies [6901a81]
  - @fnndsc/brasa@0.32.0
  - @fnndsc/calypso@0.19.3

## 5.10.1

### Patch Changes

- Updated dependencies [73c0087]
  - @fnndsc/salsa@3.21.1
  - @fnndsc/menu@0.18.0
  - @fnndsc/brasa@0.31.5
  - @fnndsc/calypso@0.19.2
  - @fnndsc/cumin@3.27.4

## 5.10.0

### Minor Changes

- 33e4f1d: A session restarts from its own browser and stays logged in. Porter's new `POST /restart` (cookie-gated: only the cookie's own session) tells the old calypso daemon why, ends it, and boots a fresh one with chell's new `--saved-token` login, which uses the token the identity saved and refuses rather than come up offline. The browser follows the boot on the greeter; a refused saved token ends at the door with the reason. On SIGTERM the daemon sends `closing` (restart, end or stop) to every surface before it exits, and a remote chell prints why it went. `porter --end` leaves `end` as the reason.

### Patch Changes

- Updated dependencies [51315ec]
- Updated dependencies [33e4f1d]
- Updated dependencies [fe4b6b4]
- Updated dependencies [2d26368]
  - @fnndsc/calypso@0.19.0
  - @fnndsc/menu@0.17.0
  - @fnndsc/cumin@3.27.2
  - @fnndsc/brasa@0.31.2

## 5.9.8

### Patch Changes

- 685ed59: ARGUS and the calypso daemon say when they are different builds. ARGUS's build writes its stamp into the bundle; the calypso daemon reads it once at start and reports it in its attach ack (`stack.surface`, optional in the wire schema). When ARGUS's own stamp differs, it says which is older and what to restart — on the status strip, in a dismissible notice, and on the console: "ARGUS is newer than the calypso daemon, so some controls won't work. Restart the calypso daemon." or "ARGUS is older than the calypso daemon. Refresh to load the new ARGUS." A remote chell prints one line at attach when its build differs from the daemon's.
- Updated dependencies [685ed59]
  - @fnndsc/calypso@0.18.0
  - @fnndsc/menu@0.16.0
  - @fnndsc/brasa@0.31.1
  - @fnndsc/cumin@3.27.1

## 5.9.7

### Patch Changes

- Updated dependencies [e057d20]
- Updated dependencies [2826f2b]
- Updated dependencies [c1cf57e]
- Updated dependencies [1c8b92d]
- Updated dependencies [e20fb09]
- Updated dependencies [ddbd551]
- Updated dependencies [32e3919]
- Updated dependencies [59399fe]
- Updated dependencies [51da853]
  - @fnndsc/brasa@0.31.0
  - @fnndsc/menu@0.15.0
  - @fnndsc/calypso@0.17.0
  - @fnndsc/cumin@3.27.0
  - @fnndsc/salsa@3.21.0
  - @fnndsc/chili@3.7.0

## 5.9.6

### Patch Changes

- Updated dependencies [51f1ca9]
- Updated dependencies [c9c018b]
- Updated dependencies [fbb1579]
- Updated dependencies [576b948]
- Updated dependencies [4864a34]
- Updated dependencies [7fb4c21]
- Updated dependencies [c371b47]
  - @fnndsc/brasa@0.30.0
  - @fnndsc/cumin@3.26.0
  - @fnndsc/menu@0.14.0
  - @fnndsc/salsa@3.20.1
  - @fnndsc/calypso@0.16.10

## 5.9.5

### Patch Changes

- fbd3f0a: The session lays the universe out itself: once the index is whole the daemon runs orrery's engines for every layout in a worker thread and keeps the places (`proc layout <name>` reports `laying` progress meanwhile). orrery is published; `layoutInput_build` builds the engines' input one way for browser and session, and the universe graph builders live in `@fnndsc/menu`. ARGUS waits on the session's progress instead of settling the same space, keeps places only for the view on stage (SHAPES apart), redraws a view already seen where it stood, and gives the session only default-physics places.
- Updated dependencies [fbd3f0a]
- Updated dependencies [fbd3f0a]
  - @fnndsc/menu@0.13.0
  - @fnndsc/brasa@0.29.0
  - @fnndsc/cumin@3.25.0
  - @fnndsc/salsa@3.20.0
  - @fnndsc/calypso@0.16.8

## 5.9.4

### Patch Changes

- f571a14: The /proc index reads what each feed's data is, once: from the first file its root job made (by name, descending into a folder), the format, and for DICOM the modality and series description from one header read. It runs after the topology sweep, as each feed's topology loads, and after a checkpoint restore; what cannot be known yet is tried again, what is known to be absent is recorded with its reason.
- Updated dependencies [e7f82dd]
- Updated dependencies [8602c78]
- Updated dependencies [a8d0d99]
- Updated dependencies [f571a14]
- Updated dependencies [d1da8ac]
- Updated dependencies [0f9ae74]
- Updated dependencies [d8e160c]
  - @fnndsc/cumin@3.24.0
  - @fnndsc/salsa@3.19.0
  - @fnndsc/menu@0.12.0
  - @fnndsc/brasa@0.28.0
  - @fnndsc/calypso@0.16.7

## 5.9.3

### Patch Changes

- Updated dependencies [53d43f6]
  - @fnndsc/brasa@0.27.0
  - @fnndsc/calypso@0.16.6

## 5.9.2

### Patch Changes

- c71418c: chell: `--door` takes a door typed without a scheme (`localhost:4180` is `http://localhost:4180`), asks for the username when the login config holds an empty one (it used to ask "Password for at …"), and says in one line when a door cannot be reached or is not an HTTP(S) address instead of dying with a stack trace.
- 99c17d8: chell: `--door` shows its "Username at …" question. The label was written beside readline's empty prompt, and readline's repaint erased it, so the question looked like a blank line. An empty answer is now refused by name instead of reaching the door as a login for nobody.
- Updated dependencies [7b89dcc]
  - @fnndsc/brasa@0.26.0
  - @fnndsc/calypso@0.16.3

## 5.9.1

### Patch Changes

- dac2d96: chell: the shell and the remote client greet through the kernel's `motd chell` where the fortune used to print, so a TTY and a browser on one session say the same thing. A session that cannot answer is left alone.
- Updated dependencies [247bf09]
- Updated dependencies [dac2d96]
- Updated dependencies [dac2d96]
- Updated dependencies [50f8a4e]
- Updated dependencies [50f8a4e]
- Updated dependencies [c82f514]
- Updated dependencies [c82f514]
- Updated dependencies [c82f514]
  - @fnndsc/cumin@3.23.1
  - @fnndsc/brasa@0.25.0
  - @fnndsc/menu@0.11.0
  - @fnndsc/calypso@0.16.1

## 5.9.0

### Minor Changes

- c1178a0: A terminal comes through the door: `chell --remote --door <url>`.

  The porter lets a browser in with a password and a cookie; a terminal can come the same way. `chell --remote --door https://titan/` asks for a username and a password (or takes `-u` and `-p`), logs in at the door once, prints the session's boot rows as it boots if it has to, and attaches to the session's wire — `wss://titan/s/<key>/` — with the door's cookie on the upgrade. No attach token reaches the terminal; the door holds it, as it does for a browser. Same login, same session, same idle rules, from a shell: a `-c` one-shot works too.

- 7bba167: The door hands a token: a session can be started by a front that already logged the operator in.

  Today a session is started by the operator, at a terminal, with a password: `chell user@url -p … --daemon`. A login front on a shared host — the porter, the display manager the browser surface needs — exchanges the password for a CUBE token itself and holds the token, never the password. This is the seam that lets it start a session with what it holds.

  - cumin `connection_connectWithToken({ user, url, token })`: proves the token against the server BEFORE writing anything, so a refusal leaves the saved context alone; never exits the process; the refusal travels in the outcome, not on the error stack.
  - brasa `sessionConnect_withToken(user, url, token)`: the headless connect beside `sessionConnect_fromSaved`, setting the context the way a credentialed boot does and leaving the working directory as it was.
  - chell `--auth-token-stdin`: the token comes in on stdin, one line, never on argv where `ps` shows it to the host. Refuses by name: without a `<user>@<url>`, beside `--password`, or with no line on the stream. The boot row reads `Connect  Connected to <url> (token)`.
  - chell `--daemon` off a TTY no longer spawns a console onto its pipe — a boot ends at a login only where there is a terminal to log in on; otherwise the daemon says so and keeps listening, as the standalone `calypso` binary already did.
  - menu `@fnndsc/menu/logo`: the mise brain and its frame renderer move from the kernel to the wire package, decoding with `atob` and touching no Node builtin, so a browser can draw the same brain a terminal boot does. brasa re-exports it; chell and calypso keep their import.

  Exemplar `14_tokenLogin` starts a daemon this way against a live CUBE, off a TTY, in isolated directories, and proves the Connect row and a live berth.

### Patch Changes

- 4ee180c: A session outlives its door: the porter's lifecycle.

  porter: a restarted porter adopts the sessions its predecessor started, from their berths under the state directory, rather than starting rivals. Idle sessions — no wire open, nothing through the door for `PORTER_IDLE_HOURS` (a day, like the cookie) — are ended by a sweep every minute: the process only; the state directory stays and the next login boots warm. `porter --status` lists the state directory's sessions and whether each answers. `deploy/` carries a systemd unit (a `porter` user, `KillMode=process` so a stopped door keeps its sessions), an env file example, and a Caddyfile for TLS in front. Boot lines kept per session are capped at 2000.

  calypso: a berth records the daemon's pid, so a host that did not start a daemon can still end it.

  chell: a daemon off a TTY tolerates EPIPE on its stdout and stderr — the porter that started it may stop first, and a session outlives its door.

- 810f3ba: chell: `--no-logo` hides the logo. It used to print it anyway, uncoloured — the flag only chose the colour — so a boot read off a pipe carried a still brain above its rows. Off a TTY the flag is implied.
- Updated dependencies [e74ce1d]
- Updated dependencies [1b2f7f7]
- Updated dependencies [3320487]
- Updated dependencies [e74ce1d]
- Updated dependencies [d1a1c0d]
- Updated dependencies [a010cb0]
- Updated dependencies [8a8dc25]
- Updated dependencies [3a8cd1b]
- Updated dependencies [03e0f87]
- Updated dependencies [1bdf876]
- Updated dependencies [854ba2e]
- Updated dependencies [4ee180c]
- Updated dependencies [80ddce6]
- Updated dependencies [3320487]
- Updated dependencies [a010cb0]
- Updated dependencies [5b520c7]
- Updated dependencies [3c6a0d3]
- Updated dependencies [ca3e39b]
- Updated dependencies [7bba167]
- Updated dependencies [1c169d7]
- Updated dependencies [fc4eb7e]
- Updated dependencies [43b9440]
  - @fnndsc/brasa@0.24.0
  - @fnndsc/salsa@3.18.2
  - @fnndsc/calypso@0.16.0
  - @fnndsc/menu@0.10.0
  - @fnndsc/chili@3.6.7
  - @fnndsc/cumin@3.23.0

## 5.8.1

### Patch Changes

- 3f96d86: A daemon comes up where the operator left it. A credentialed boot used to write `/` into the working-directory context after connecting, so every restart began at the root whatever was stored; it no longer touches the directory, and with nothing stored the kernel's home default (`/home/<user>`, now exported as `homePath_of`) applies to the boot context too.
- Updated dependencies [3f96d86]
- Updated dependencies [6d8a595]
- Updated dependencies [a4a38b1]
- Updated dependencies [0d99ec5]
- Updated dependencies [480632d]
- Updated dependencies [b4d9282]
- Updated dependencies [b337285]
- Updated dependencies [ab127ea]
  - @fnndsc/brasa@0.23.1
  - @fnndsc/salsa@3.18.1
  - @fnndsc/calypso@0.15.1

## 5.8.0

### Minor Changes

- 9cf2ea2: `image <path>`'s text reflection now carries a thumbnail of the middle slice, so a TTY sharing the session shows the picture, not only the facts. The kernel reads the slice's pixels (`dicomSlice_gray` in salsa, uncompressed transfer syntaxes via dcmjs), window/levels to 8-bit with MONOCHROME1 inverted, and box-downsamples to a cell grid; brasa renders it as an ASCII ramp on any pipe or ANSI truecolour half-blocks (`▀`) on a colour terminal. Colour is a new declared surface capability: ARGUS declares it (its DOM console renders ANSI), chell reads its own terminal through chalk, a bare pipe gets the ramp. Compressed pixels say so in one line rather than pulling a codec into the kernel; an unreadable slice leaves the facts and no picture. The ASCII ramp is always the floor.

### Patch Changes

- Updated dependencies [9cf2ea2]
- Updated dependencies [d133ef6]
- Updated dependencies [c70e11e]
  - @fnndsc/salsa@3.18.0
  - @fnndsc/brasa@0.23.0
  - @fnndsc/menu@0.9.0
  - @fnndsc/calypso@0.15.0
  - @fnndsc/cumin@3.22.1

## 5.7.4

### Patch Changes

- Updated dependencies [c601a42]
  - @fnndsc/calypso@0.14.0

## 5.7.3

### Patch Changes

- Updated dependencies [4af65f4]
- Updated dependencies [163e4b1]
- Updated dependencies [aa923c6]
- Updated dependencies [59aa79b]
  - @fnndsc/calypso@0.13.2
  - @fnndsc/salsa@3.17.0
  - @fnndsc/brasa@0.22.0
  - @fnndsc/cumin@3.22.0

## 5.7.2

### Patch Changes

- Updated dependencies [7c793ad]
- Updated dependencies [7c793ad]
- Updated dependencies [af2df66]
- Updated dependencies [af2df66]
- Updated dependencies [af2df66]
- Updated dependencies [0eb202f]
- Updated dependencies [b9ec3aa]
- Updated dependencies [183bf02]
  - @fnndsc/brasa@0.21.0
  - @fnndsc/menu@0.8.0
  - @fnndsc/salsa@3.16.0
  - @fnndsc/calypso@0.13.1
  - @fnndsc/cumin@3.21.1

## 5.7.1

### Patch Changes

- ef4a718: The standalone `calypso` binary ends its boot at a login, like `chell --daemon`: on a TTY the daemon's own terminal becomes its first surface, an ordinary `chell --remote` spawned onto it, rather than the old resting face. The console loop, the cage and the reattach grammar move into calypso (the daemon's own package), with the surface launch injected — chell spawns itself, the calypso binary spawns `chell` from the path — so both hosts share one console. Off a TTY neither attaches; the daemon just keeps listening.
- Updated dependencies [ef4a718]
  - @fnndsc/calypso@0.13.0

## 5.7.0

### Minor Changes

- 3d11f59: Boot readout, second pass. A step that starts as `[PENDING]` (or falls to `[RETRY]`) is now rewritten in place when its outcome lands, the way a boot screen settles a row rather than repeating it beneath, so a settled step leaves one `[ OK ]`/`[FAIL]` row and no open pending row. The brain animation and the readout now share one stdout row counter, so neither miscounts the other's scrolling; a row that has scrolled off the screen, or an outcome taller than the pending row it replaces, appends as before. The daemon banner paints each package in three parts (its name bright, the rest of its backronym plain, the version dim in one column) and carries the build hash on its own CALYPSO row, so the redundant headline line is gone; a remote surface paints the daemon's stack the same way.
- 9c320a0: The boot ends at a login. An interactive `chell --daemon` no longer rests on the console face: once the daemon is listening it puts an ordinary `chell --remote --attach` surface on its own terminal, as a child on the wire, so the boot log runs straight into a prompt. `exit` detaches and leaves the daemon running, Enter attaches again, Ctrl-C at the idle terminal stops the daemon, and whatever the daemon writes while a surface holds the terminal is held (calypso `consoleCage_start`/`consoleCage_stop`) and printed on detach. Every chell REPL, local or remote, now guards its idle prompt: a stray line (another surface's output, a late warm-up) lands on its own line with the prompt redrawn beneath it.

  The boot readout is lifted with it. A warm-up step running behind the prompt printed its pending row twice and never reported an outcome; it now prints once as `[PENDING]` and settles on the daemon's readout as `[ OK ]` with what it cached or `[FAIL]` with why. Every count takes its noun in the right number (`1 PACS query`, `3 feeds`) through a new brasa `count_noun`. The daemon banner writes every package out in full (brasa `stackBanner_build`/`stackBanner_compose`), adds an ARGUS row when a web surface is served, and drops the welcome; the remote surface banners the daemon's stack the same way. A daemon bound on every interface advertises its fully qualified host name.

### Patch Changes

- 89d3287: Daemon boot leaves no open `[PENDING]` row. The steps that warm behind the prompt were settling after the login took the terminal, which caged them, so their `[ OK ]` never reached the row and it stayed `[PENDING]` on screen. The boot now waits those steps out before the login — they settle in place, every row reading `[ OK ]` or `[FAIL]` — while the daemon is already listening, so nothing reaches it any later for the wait. The startup banner keeps its version column clean: the build hash moves from the CALYPSO row, which it pushed past the column the other rows share, to the `listening` line. The fortune is gone from daemon startup.
- 711e1b3: The boot's PACS-query row now reports the amount of queries the index holds, not the one record a resume re-touched. The sweep resumes from the newest query it already has with an inclusive `min_creation_date`, so CUBE hands that boundary record back and the loop counted it — a resume that found nothing new still read `Indexed 1 PACS query`. The sweep now counts only records the index did not already hold (new `QueryIndex.has`), carries the total held in its result, and the boot row reads `1905 PACS queries indexed`, adding `, N new` only when the top-up actually filed some.
- Updated dependencies [3d11f59]
- Updated dependencies [89d3287]
- Updated dependencies [9c320a0]
- Updated dependencies [711e1b3]
- Updated dependencies [612c052]
- Updated dependencies [d89e31b]
  - @fnndsc/brasa@0.20.0
  - @fnndsc/calypso@0.12.0
  - @fnndsc/cumin@3.21.0
  - @fnndsc/salsa@3.15.0
  - @fnndsc/menu@0.7.0

## 5.6.2

### Patch Changes

- Updated dependencies [49634f2]
- Updated dependencies [49634f2]
- Updated dependencies [49634f2]
- Updated dependencies [49634f2]
- Updated dependencies [2545ffa]
- Updated dependencies [2545ffa]
- Updated dependencies [2545ffa]
  - @fnndsc/brasa@0.19.0
  - @fnndsc/calypso@0.11.0
  - @fnndsc/cumin@3.20.0
  - @fnndsc/menu@0.6.0

## 5.6.1

### Patch Changes

- 6cd5ab1: fix(chell): the prompt's feed-indexing segment says FAILED, in the failure colour, when a walk stopped
- 57ba039: fix(chell): both prompt themes show every feed being indexed, not only the earliest
- 98ab832: feat(chell): the prompt says `[roster: full walk]` or `[roster: delta]` while the roster is being brought up to date
- Updated dependencies [6cd5ab1]
- Updated dependencies [6cd5ab1]
- Updated dependencies [6cd5ab1]
- Updated dependencies [6cd5ab1]
- Updated dependencies [57ba039]
- Updated dependencies [57ba039]
- Updated dependencies [57ba039]
- Updated dependencies [57ba039]
- Updated dependencies [adf8cc1]
- Updated dependencies [adf8cc1]
- Updated dependencies [98ab832]
- Updated dependencies [98ab832]
- Updated dependencies [98ab832]
- Updated dependencies [98ab832]
  - @fnndsc/brasa@0.18.0
  - @fnndsc/cumin@3.19.0
  - @fnndsc/menu@0.5.0
  - @fnndsc/salsa@3.14.0
  - @fnndsc/calypso@0.10.2

## 5.6.0

### Minor Changes

- 349d7d2: feat: a missing destination is asked for, not refused with a usage line

  `mv foo` names what to move and never says where. Until now that was a usage line — telling an operator the shape of a command they had just typed correctly enough to be understood, instead of asking them the one thing they had not said. A required operand with no value is the same sentence as a value-taking flag with no value, and now gets the same answer: `mv` and `cp` ask.

  The ask is the typed `path` ask that already exists, so neither verb knows which surface it is talking to: a terminal renders it as a line, and a surface that browses borrows a files pane for it. It opens where the source already lives, wants a directory when there is more than one source, and its committing control reads `MOVE HERE` or `COPY HERE`.

  It offers no default name. The only name `mv` could propose is the source's own, and the first live run took Enter as exactly that and moved a file onto itself. The rule that came out of it holds for every path ask, and the terminal now implements it directly: the **anchor** says where to look, the **suggestion** says what to offer, and a verb with nothing to offer offers nothing — Enter on such a question answers nothing rather than answering with the question.

  An abandoned ask moves nothing and says so (`mv: no destination given; nothing moved.`), rather than failing with a description of `mv`.

- 8312a79: feat(chell): a terminal answers the same typed question

  A terminal has one instrument — a line — so a location ask cannot borrow a browser the way a graphical surface does. It renders into the line instead: the composed default in brackets, and Enter takes the offer.

  ```
  Where should the table go? [/home/rudolphpienaar/pacs-2026-09-07.csv]
  ```

  The answer a terminal commits is then the same answer an errand would have committed, without either surface knowing the other exists — which is the point of putting the _kind_ on the wire rather than a rendering. A yes/no says which letters it takes and offers no default, because there is no safe guess. A prompt from a daemon that predates typed asks reads exactly as it always did.

  Exemplar 12 closes the epic by driving the whole path through the kernel with a scripted surface: a value-taking flag given no value asks and the question says what it wants; the answer is what happens next and the file lands where it said; abandoning writes nothing and the command says so; and a session sitting in a provider path is not offered as a destination.

  It caught the epic's last defect: **an abandoned ask was throwing the answer away with the writing.** The model crosses either way now — the operator waited for that answer, and only the writing of it did not happen.

- 404f5e3: feat: a PACS question that names several patients becomes several questions

  A PACS will not match a list. `PatientID:4356325\4433255` — the DICOM multi-value form — returns nothing from a real PACS, and the standard agrees: _List of UID Matching_ is defined only for attributes whose VR is `UI`, and `PatientID` is `LO`. So asking after two hundred MRNs is two hundred C-FINDs, and the fan-out is forced rather than chosen.

  **The inline comma list is the operator's own syntax, now accepted.** `query PatientID:1234,4532,6654` is three questions and one table; `query PatientID:1234,StudyDate:20240101` still means what it always meant. There is nothing to disambiguate — every genuine term carries a colon, so a bare segment can only be another value for the key before it. Several multi-valued keys fan out over their cross-product, and above 32 the command refuses by name rather than launching hundreds at a shared clinical system.

  **`--patients <list|@file>` carries a real cohort.** `@file` names a file in ChRIS storage, read through the session's own path and never the engine's host disk, so the flag behaves identically from a local shell, a remote shell and a browser — and a list on somebody's laptop reaches it through `upload`, the gated door. One MRN per line; blanks and `#` comments ignored.

  **Four questions in flight**, in one constant. Not operator-settable: nobody inside mise knows the right number for a given hospital, and a flag that can hurt a shared clinical system will eventually be set to 50.

  **A failure is not a miss.** A question that could not be asked is recorded `unasked` with its reason, never as zero studies. A server that timed out has told us nothing; a PACS that answered with nothing has told us something, and a clinician acts on the difference. The table says `FOUND 2 · NONE 1 · UNASKED 0`, and the model carries every row.

  **Replay applies per patient**, so a cohort's already-asked MRNs never leave the building — verified live against rows answered eight months ago.

  Two things found live while proving it:

  - **CUBE refuses a second PACSQuery with a title it already holds for that server.** A fan-out under one title had every question after the first come back `You have already registered a PACS query with title=…`, which a less careful client would have rendered as "no imaging". Each question now carries its own title. Recorded in `docs/CUBE-gaps.adoc`.
  - **`chell -c` and `chell -f` had no replay at all.** A one-shot skips the boot warm-up — correct — but that left the replay index neither restored nor written, so a scripted cohort re-asked the PACS every single time, and the audit workflow the fan-out exists for was the one workflow replay never reached. A one-shot now primes the index from the checkpoint a previous run paid for, and flushes what it learned before exiting, since the debounced writer's timer never fires in a process that short.

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
  - @fnndsc/calypso@0.10.0
  - @fnndsc/salsa@3.13.0
  - @fnndsc/cumin@3.18.0
  - @fnndsc/menu@0.4.0
  - @fnndsc/chili@3.6.6

## 5.5.1

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
  - @fnndsc/calypso@0.9.1

## 5.5.0

### Minor Changes

- 5dc064e: feat(boot): warm-up leaves the gate, and a failure that leaves it is still heard

  Boot blocked on four prefetches in front of the prompt. Measured against a live CUBE, `/PUBLIC` costs 8.4 seconds and `/SHARED` 9.3 — roughly eighteen seconds an operator spent watching a prompt that was already theirs, buying freshness the stale-serve path delivers a moment later anyway, since the checkpoint restore has already put those listings in the cache.

  Boot now blocks only on `/bin`, which completion cannot work without: an empty completer reads as a broken prompt rather than a fast one. Groups, Feeds, Public and a newly added `/SHARED` step warm behind the prompt under a new `PENDING` boot status. They keep their bounded retry policy; a transient failure should be retried before it is announced.

  `/SHARED` had no step at all before. That is where another identity's work becomes visible, and with nothing to fail, a CUBE that stopped serving shared paths stayed silent until somebody went looking.

  **A deferred step leaves the boot failure gate**, so its failure can no longer stop a daemon binding — and a boot readout has scrolled away by the time it arrives. The failure is held until a later attempt succeeds and carried on the prompt context, so every surface says it: chell's prompt reads `[warm-up failed: groups]`, and argus names it on the JOBS readout in mars with the reason on hover. Named rather than counted, because "Groups" tells an operator which capability is degraded where "1 warm-up failed" only tells them to go looking.

  Nothing reports a deferred completion. A warm that finishes and changes nothing is not news.

  Carries AEGIS law `deferred-warmup-failure-persists` with its smoke, which drives the surface's real prompt-context path rather than asserting a stub.

- 3afaa65: fix(cache): the listing cache's lifetimes stop lying, and the boot row says what it holds

  `ttl_get` compared exact paths or a doubly anchored wildcard, so `/home` never covered `/home/<user>/feeds` and `/feeds/*` matched a top-level path this VFS does not have. Two of the four tuned entries did nothing, and everything but `/bin` and `/PUBLIC` silently took the three-minute default. Matching is now longest-prefix on whole segments, so `/bindings` does not inherit `/bin`.

  Lifetimes are now split by whether a signal exists rather than guessed per path. Where `/proc` reports movement — `/home`, `/SHARED`, `/PUBLIC` — the clock is a backstop against a missed notification and runs long. Where nothing reports, it stays short. The plugin and pipeline indexes go to a day, because registration is an administrative act on a scale of months and an hourly re-walk was the most aggressive refresh in the table for the least mutable data in the system.

  The cache holds 500 path listings rather than 100, and says so the first time it fills: an evicted listing also leaves the checkpoint, so a session that quietly crossed the old cap came back thinner than the one that wrote it.

  The boot row `Listings` becomes `Folders` and reports age alongside count. It is the restored folder-listing checkpoint, not the plugin index, which has its own `Plugins` and `Pipelines` rows; and a count with no age says nothing about whether the restore was worth having.

  Also records the change-discovery entry in `docs/CUBE-gaps.adoc`: CUBE offers no way to ask what changed, which is why clients invent clocks at all.

- 5b4b7db: feat(cache): feed movement dirties the folder listings it touched

  `/proc` already learns when a feed arrives, vanishes, or finishes work. The folder-listing cache, in the same process, heard none of it and re-fetched on a clock instead. This is the wire between them.

  Two rules govern it. Your own act deletes and someone else's act dirties: a mutation removes the entry, because showing a file you just deleted is incoherent, while a job's output or a colleague's share is not wrong but merely behind, so the entry is marked and served at once while it refreshes behind. And movement coalesces, because a feed completing a fan-out stage lands many terminal transitions in the same second.

  Nothing subscribes to the process cache's change stream. That stream fires on every instance add and status observation, so indexing one large feed emits tens of thousands of events, none of which mean a file appeared. Movement is pushed from the three places that actually know: a job crossing into a terminal state, a feed arriving on the roster, and a feed vanishing from it. A merely-running job says nothing, having produced nothing to list.

  Feed-to-path mapping needs no new index. `path_extractFeedID` already reads a feed id out of any cached path, so a shared feed under `/SHARED` is reached by the same rule as one under a home folder, with no extra wiring.

  An arrival changes the folder a feed appears _in_ rather than anything inside it, and the roster speaks only in feed ids, so a host declares those folders once through `rosterParents_set`.

  An arrival is routed by how this identity sees the feed, so a public feed landing on a busy CUBE dirties the public root and not the identity's own feeds folder. A departure is not staleness at all: a feed this identity can no longer reach has no contents to serve, and a dirty entry is still served while it refreshes, so its cached listings are removed rather than marked.

- 4f034b9: Host control: `chell --daemon --host-control[=shell,files,pipes]` lets the daemon declare capabilities of its own — `!` runs on the daemon host, pipe segments run there, `upload`/`download` reach its disk — off by default, refused on a non-loopback bind without `--expose-host-control`, and annunciated everywhere (attach ack `hostControl`, the daemon face, the prompt's HOST segment, a remote shell's banner). Without the `files` tier, `upload` under a daemon now refuses instead of reading the daemon host's disk.

### Patch Changes

- 75f1e5f: fix(boot): a step's label stops moving when it finishes

  A boot step is announced while it runs and again when it settles, and the two lines disagreed about where the label starts. The running line hardcoded a five-space indent against a comment asserting `[ OK ] ` was seven characters wide; the finished line pads its tag to the widest tag and adds a space. The label therefore jumped a column as each step resolved, and the plain non-interactive log was out by three rather than one.

  The indent is now derived from the host's own tag width and from whether a spinner glyph precedes the text, since an animated line draws a frame and a space of its own and owes only the remainder while a plain log line owes the whole column. `chell` passes the width it actually renders with, so a longer status added later moves both lines together.

  The arithmetic lives in its own import-free module, because the wider engine graph cannot be loaded under jest and an untestable alignment rule is how the first version came to be wrong.

- fe1dd0e: fix(boot): the boot readout's label column stops moving with the status

  Status tags are not all the same width — `[RETRY]` is a character wider than `[ OK ]` — and only the label was padded, so a retry row's label and message sat one column right of every other row's.

  Tags now come from a table and are padded to the width of the widest, with the padding applied to the bare text before colour, since padding a colour-wrapped string counts the escape sequences instead of the visible characters. The width is derived from the table rather than written down, so a longer status added later widens every row together instead of shunting one label out of line.

- f8d1b1c: Index movement is annunciated: a feed's first-visit topology load (`feed 812 indexing: 3400/20000 17%`) and roster arrivals (`+feed 812`, feeds created since or newly shared) reach the prompt context's `procWarmup` segment — `feed`, `arrived`, and `sweeping` so a renderer can tell a sweep from a load — and the chell prompt renders both. The process cache keeps the two registers (`feedLoad_progress/clear/get`, `arrivals_note/recent`); the salsa feed walk and roster syncs feed them.
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
- Updated dependencies [aaf0159]
- Updated dependencies [85c6813]
  - @fnndsc/cumin@3.17.0
  - @fnndsc/menu@0.3.0
  - @fnndsc/brasa@0.16.0
  - @fnndsc/calypso@0.9.0
  - @fnndsc/salsa@3.12.1

## 5.4.3

### Patch Changes

- 25c4ebc: Faster daemon entry. A restored `/proc` roster now goes into service on a delta (feeds newer than the highest restored id) instead of a full feed-index walk; the full walk runs behind the listening daemon and reports how many feeds moved while it was away, each refreshing on its next visit (`procRoster_bootSync`; `procRoster_sync` now returns the feeds it brought in or found changed). The rendered `/etc/group` projection lives in the listing cache, so it survives a restart with the listings: past its freshness window it serves at once and re-renders behind itself, and a local membership change still forces a synchronous re-render. The listing checkpoint accepts any JSON payload, not only listings.
- Updated dependencies [25c4ebc]
  - @fnndsc/salsa@3.12.0
  - @fnndsc/cumin@3.16.1

## 5.4.2

### Patch Changes

- 7a0f06e: The `/proc` checkpoint is now a directory of per-feed shards (`~/.cache/chell/proc/<identity-key>/roster.json` + `feed-<id>.json`) instead of one file. A mutation to one feed rewrites only that feed's shard, throttled to one write per 30 seconds per shard with the last change never dropped, so a growing 80k-node feed no longer drags the whole index back to disk on every change; a torn write can damage at most one feed, and a shard whose feed left the roster is ignored on restore. Execution metrics observed on a revisit are now checkpointed too (they previously never triggered a save). A legacy v2 single-file checkpoint is read once and migrated into shards; the old file is left in place for this release. Cache change events now say what they touched (`roster`, `feed`, `all`, `lifecycle`).
- c716624: Directory listings survive a restart. The listing cache is checkpointed (identity-keyed file under `~/.cache/chell/vfs/`, throttled writes) and restored at boot with each entry's original timestamp, so a restored listing is exactly as stale as it really is. Stale handling itself is fixed: the listing path used to serve any cached entry regardless of its TTL (a listing never refreshed until eviction or `ls -f`). Now a fresh entry serves as is; a stale one is served at once and revalidated behind itself when a host can carry the refresh (the daemon publishes the fresh `fs.listing` on the ambient bus, marked `fresh`), and is refetched in line at a plain console. `ls` models carry `fresh` per listing; `vfs.listing_get` exposes the listing with its freshness.
- Updated dependencies [920e0ac]
- Updated dependencies [7a0f06e]
- Updated dependencies [920e0ac]
- Updated dependencies [c716624]
- Updated dependencies [cece0dc]
- Updated dependencies [97af423]
  - @fnndsc/cumin@3.16.0
  - @fnndsc/salsa@3.11.0
  - @fnndsc/brasa@0.15.0
  - @fnndsc/menu@0.2.0
  - @fnndsc/calypso@0.8.0

## 5.4.1

### Patch Changes

- Updated dependencies [85791b3]
  - @fnndsc/brasa@0.14.0
  - @fnndsc/calypso@0.7.1

## 5.4.0

### Minor Changes

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

- 58e3a37: A daemon boot keeps its normal buffer text-only, by law.

  The boot-phase pulse (revive-and-animate after login) could outlive the
  whole boot on a tall terminal, and its final repaint — cursor arithmetic
  over wrapped, ANSI-heavy lines — stamped the static brain over the daemon's
  token and attach lines, which the console face's Esc view then faithfully
  restored, mangled. Daemon mode now skips the revive entirely: the animated
  brain lives solely on the face's alternate screen, and the boot report and
  addresses survive verbatim for Esc. The interactive chell REPL keeps its
  boot animation unchanged.

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

- 7672c6e: Two regressions found by running a daemon.

  **The boot animation fed its own position counter.** The pulse repaints through
  `process.stdout.write`, which is what the row counter hijacks. Counting
  newlines it was accidentally safe, since a repaint emits none; counting screen
  rows it was not, because each repaint writes thirty lines with no newline and
  the pending-column position accumulated. The offset grew by roughly 380 rows a
  second, and the logo climbed the screen painting over everything above it. The
  animation now writes through the unhijacked handle, and a test asserts the
  counter does not move while it runs — against the broken version it moved 762
  rows in two seconds.

  **Daemon boot showed no spinners.** Warm-up runs before the daemon installs its
  own sink, so the engine is still writing to the terminal it is booting in — but
  nothing installed a progress renderer there, and the migrated spinner's typed
  events went into `StdoutSink`'s null renderer. Before the spinner emitted typed
  events it wrote escapes straight to the status channel, so this only appeared
  once it stopped doing that, and only in daemon mode. Warm-up now installs a
  terminal renderer when the session is interactive.

- 79fdd4a: The brain lights up on a clear screen when credentials are accepted.

  The pulse repaints by moving the cursor up to where the logo is, so the logo
  must still be on screen. By the time login finishes it usually is not — the
  logo and the login output have scrolled past the top — and an animation that
  cannot reach its anchor paints at row zero instead, over the boot report and
  the daemon's own addresses. The flickering brain and the mangled banner were
  the same defect.

  `logo_reviveOnScreen` homes the cursor, clears below it, and redraws the logo
  alive at row zero. The anchor is restored and boot output has a whole screen to
  flow into beneath it, so the animation runs through warm-up and the banner
  without reaching anything else.

  It also restores the sequence the animation existed for: the brain is dead
  while credentials are checked, and comes to life once they are good.

- bcd9c5c: The boot animation stops before it can paint over what a daemon prints.

  The pulse repaints by moving the cursor up a fixed number of rows, which holds
  only while the logo is still on screen. A daemon boot prints far more than a
  window holds — the logo, the warm-up panels, then the addresses — and once the
  buffer scrolls, moving up clamps at row zero. The logo is then painted over
  whatever is visible there, which is the ARGUS link and the attach token it had
  printed a moment earlier.

  No arithmetic recovers an anchor that has scrolled away, so the animation now
  stops while it is still correct: it runs while the logo is on screen and holds
  still once output has pushed it past the top.

- e86b5df: The boot animation no longer paints over long output.

  The pulse repaints the logo by moving the cursor up a fixed number of rows, and
  it counted rows by counting newline characters. A line longer than the terminal
  is wrapped into several screen rows while contributing one newline, so the
  count under-shot and the animation painted on top of whatever had been printed.

  The daemon banner made it plain: its identity line and its ARGUS URL, which
  carries a 64-character token, both wrap — and both were the lines that came out
  mangled.

  Rows are now counted as rows, with escapes stripped so cursor and colour codes
  do not inflate a width, and with the column position carried across writes that
  do not end in a newline.

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

- Updated dependencies [1d600ac]
- Updated dependencies [eebdc7d]
- Updated dependencies [5d131c8]
- Updated dependencies [0adb4f2]
- Updated dependencies [31c2a50]
- Updated dependencies [a78b5ee]
- Updated dependencies [1c195a7]
- Updated dependencies [a3bd3e9]
- Updated dependencies [19a4d5b]
- Updated dependencies [9ed68cd]
- Updated dependencies [790f994]
- Updated dependencies [e58bf58]
- Updated dependencies [e062dbf]
- Updated dependencies [87f7c59]
- Updated dependencies [56ade16]
- Updated dependencies [2bb9c29]
- Updated dependencies [3125517]
- Updated dependencies [28b9a9f]
- Updated dependencies [976c753]
- Updated dependencies [8842ab4]
- Updated dependencies [2c38d8b]
- Updated dependencies [bf09355]
- Updated dependencies [b39b584]
  - @fnndsc/salsa@3.10.0
  - @fnndsc/brasa@0.13.0
  - @fnndsc/calypso@0.7.0
  - @fnndsc/cumin@3.15.0

## 5.3.3

### Patch Changes

- Updated dependencies [0ad04f2]
- Updated dependencies [1928d4b]
  - @fnndsc/brasa@0.12.0
  - @fnndsc/calypso@0.6.0

## 5.3.2

### Patch Changes

- Updated dependencies [14f8ee8]
- Updated dependencies [4da2673]
- Updated dependencies [69b0617]
- Updated dependencies [7ed8e1c]
- Updated dependencies [7dc3bca]
  - @fnndsc/cumin@3.11.0
  - @fnndsc/salsa@3.7.0
  - @fnndsc/chili@3.6.5
  - @fnndsc/brasa@0.11.0
  - @fnndsc/calypso@0.5.1

## 5.3.1

### Patch Changes

- 5285bd5: Cast burndown to the adapter floor. The wire contract gains the pipelines
  surface (`pipeline_get` with piping items and plugin metadata handles,
  `pipelineSourceFilesPage_get`); salsa's pipeline modules, feed joins, and
  brasa/chili call sites migrate onto typed accessors and honest converters.
  The repository's `as unknown as` count is now 2, both inside the licensed
  adapter seam, and the CI ratchet holds it there. chell progress bars also
  draw on the renderer's configured stream instead of assuming stdout.
- Updated dependencies [5285bd5]
- Updated dependencies [919648f]
  - @fnndsc/cumin@3.10.0
  - @fnndsc/salsa@3.6.1
  - @fnndsc/chili@3.6.4
  - @fnndsc/brasa@0.10.1

## 5.3.0

### Minor Changes

- 67377a3: Unify the five correlation-id request/reply implementations onto one `RequestBroker`. The daemon's four surface-delegated brokers (prompt, pipeline segment, host shell, edit) and the remote client's own pending-request map previously each reimplemented the id/pending/close lifecycle with divergent correctness; all five now share one class that uniformly guarantees origin-validated settles (no surface can answer another surface's prompt), close-listener removal on settle (no per-request listener leak), and rejection when the origin disconnects. The protocol gains optional `promptError` and `editError` messages (additive, no version bump) so a surface can report a failed or impossible prompt or edit. Behavior change on the remote surface: a client without a prompt, pipe, or edit handler now reports the inability as an error instead of silently answering empty, passing pipe input through unchanged, or returning an unchanged "successful" edit.
- b2f5ad3: Greet every surface with the stack's identity. Builds now record the short git hash they were produced from (`dist/buildinfo.json`, written by the new `scripts/buildinfo.mjs` build step), and brasa exposes it through `buildHash_get` alongside `welcomeLine_build`/`welcomeLine_compose`, which render a banner of the form `ChELL Executes Layered Logic, v 5.3.0 (886f09). Welcome.` An interactive chell session prints the banner and a short fortune at boot, the calypso daemon announces its banner plus an aligned version line for every stack layer (chell, brasa, chili, salsa, cumin, calypso) when it starts listening, and the attach handshake gains an optional `stack` field carrying all six versions and the build hash, so a remote surface banners the daemon's full reported stack rather than its local install's. `fortune_random` is exported for reuse, with an optional line-count bound so banners favour short cookies.

### Patch Changes

- 2e60785: Cache the `/etc/group` projection per CUBE connection for five minutes,
  invalidate it after ChELL membership changes, and show semantic inspection
  progress while an uncached projection is resolving.
- 66bc932: Add ChELL group membership commands and include current CUBE usernames in the
  live `/etc/group` projection.
- 8ec8a4b: Add explicit, command-scoped CUBE elevation with `sudo <command>`. The active surface collects an administrator identity and hidden password; a temporary CUBE client runs only the nested command, then the normal session is restored. Group membership and plugin registration now suggest a copyable `sudo` rerun after an authorization failure, and plugin registration no longer owns a separate interactive admin prompt.
- d0ac04f: Preserve failure causes and tighten cache contracts. Errors that were replaced by generic messages now carry their real cause: controller and handler creation failures name the underlying error instead of "no ChRIS context", `cat` shows the actual fetch failure, docker command failures surface stderr detail, context-set errors actually print, settings load/save failures are announced instead of silently using defaults or losing changes, unreadable berth and discovery files are named instead of reading as "no daemon", token-file read errors are distinguished from the logged-out state, and resource deletes report why they failed. Every remaining deliberate error absorption now carries a dated adjudication comment. Cache contracts: the PACS provider's decoded-query cache caches settled results only and is size-bounded; the object-context factory gains an eviction hook (`objContext_evict`) for deleted plugin or feed ids; `mv` and `cp` invalidate the whole affected listing subtree; and a new PACS query invalidates the cached `/net/pacs/queries` listing so it appears in the next `ls` immediately.
- 50e9bb1: Make CUBE group membership commands name-first and batch-capable. `group members`, `group inspect`, `group adduser`, and `group removeuser` now accept an exact group name or a numeric ID; add and remove accept multiple usernames, report every result, and make already-satisfied membership changes successful no-ops.
- d0ac04f: BEHAVIOR CHANGE: failures no longer read as empty results. Commands that previously printed nothing and exited 0 when a fetch failed now report the error and exit non-zero, following the codebase's `Result<T>` pattern throughout. Affected surfaces: listing a PACS study or series that does not exist errors instead of showing an empty directory; `store list`/`store search` and `compute list` error when the store or CUBE is unreachable instead of showing no entries; plugin registration no longer defaults to the `host` compute resource when the compute fetch failed; `rm` on a feed fails when running jobs could not be cancelled instead of claiming success; a recursive scan that cannot list a subtree reports the exclusion instead of silently omitting it; batch job-status gaps and disconnected status fetches push visible warnings; the native VFS distinguishes "folder absent" from "could not verify" so probe failures no longer masquerade as missing directories; `cp` fails when path resolution fails rather than proceeding with a guessed path; join-edge resolution retries after a transient failure instead of permanently recording no joins; and the remote client reports invalid daemon messages instead of silently dropping them. Exit codes are now truthful end to end: `ls` reports an error status when any listing fails instead of aggregating failures into success, and `chell -c` derives its exit code from the command's envelopes, so a failed one-shot command exits non-zero even when the builtin did not set an exit code itself.
- ac69b3e: Run ChELL shell escapes on the originating surface, including remote clients,
  instead of exposing the CALYPSO daemon host process and filesystem.
- 0e92d4d: Persist and reconcile daemon `/proc` checkpoints, fix wildcard listing of
  virtual executables, keep remote admin prompts on their originating surface,
  add a Unix-style `id` builtin for the current CUBE UID/GID projection and group
  memberships, and make versioned-plugin help, parameters, and README output
  compose correctly through terminals, pipes, and redirects.
- fa81126: Retain failed `/proc` topology sweep state and add `proc retry` to continue at
  the failed page without repeating already successful pagination work.
- Updated dependencies [2e60785]
- Updated dependencies [66bc932]
- Updated dependencies [8ec8a4b]
- Updated dependencies [d0ac04f]
- Updated dependencies [886f09c]
- Updated dependencies [3cde784]
- Updated dependencies [50e9bb1]
- Updated dependencies [d0ac04f]
- Updated dependencies [22db63f]
- Updated dependencies [ac69b3e]
- Updated dependencies [0e92d4d]
- Updated dependencies [67377a3]
- Updated dependencies [590a943]
- Updated dependencies [fa81126]
- Updated dependencies [b2f5ad3]
  - @fnndsc/salsa@3.6.0
  - @fnndsc/brasa@0.10.0
  - @fnndsc/cumin@3.9.0
  - @fnndsc/chili@3.6.2
  - @fnndsc/calypso@0.5.0

## 5.2.13

### Patch Changes

- Restore Unix-fast `cat /bin/<pipeline>` semantics and expose complete,
  potentially remote Pipeline inspection through `pipeline manifest` and the
  direct executable's `--manifest` alias.
- Updated dependencies
  - @fnndsc/brasa@0.9.9
  - @fnndsc/salsa@3.5.5

## 5.2.12

### Patch Changes

- Show a delayed, ephemeral `Reading registered pipeline…` spinner on stderr
  for slow interactive `/bin` Pipeline reads; keep pipes, redirects, and fast
  cache hits silent.
- Updated dependencies
  - @fnndsc/brasa@0.9.8
  - @fnndsc/calypso@0.4.5

## 5.2.11

### Patch Changes

- Keep the cold `cat /bin/<pipeline>` remote request count independent of node
  count and make repeated reads connection-cache hits.
- Updated dependencies
  - @fnndsc/brasa@0.9.7
  - @fnndsc/salsa@3.5.4

## 5.2.10

### Patch Changes

- Ship pipeline runtime overlays, registered `/bin` manifests, per-node
  compute/resource controls, and PACS plugin/pipeline attachment.
- Updated dependencies
  - @fnndsc/brasa@0.9.6
  - @fnndsc/cumin@3.8.4
  - @fnndsc/salsa@3.5.3

## 5.2.9

### Patch Changes

- Specify per-node pipeline runtime parameters, serializable parameter overlays,
  and the Unix boundary that keeps loops and other general programming in the
  calling shell.

## 5.2.8

### Patch Changes

- Document the planned PACS pull attachment contract for explicitly adding one
  plugin or pipeline to a newly created feed.

## 5.2.7

### Patch Changes

- Add `pacs pull --new-feed "TITLE"` to retrieve a selected PACS series set and
  create one analysis feed rooted in the resolved CUBE directories.
- Updated dependencies
  - @fnndsc/brasa@0.9.5
  - @fnndsc/cumin@3.8.3
  - @fnndsc/salsa@3.5.2

## 5.2.6

### Patch Changes

- Add controllable syntax highlighting to `cat`, including Python and other
  popular source/configuration formats, while keeping ordinary pipes and
  redirects ANSI-free.
- Updated dependencies
  - @fnndsc/brasa@0.9.4

## 5.2.5

### Patch Changes

- Carry cold, cached-refresh, and failed `/proc` lifecycle state through the
  CALYPSO prompt contract; reorder p10k segments and render distinct lifecycle
  clues for local and remote surfaces.
- Updated dependencies
  - @fnndsc/cumin@3.8.2
  - @fnndsc/brasa@0.9.3
  - @fnndsc/calypso@0.4.4

## 5.2.4

### Patch Changes

- 1930297: Abbreviate the authenticated user's home directory as `~` in both prompt
  themes and refresh their shared palette with vivid Powerlevel10k-inspired
  truecolor accents and high-contrast Font Awesome prompt icons.

## 5.2.3

### Patch Changes

- 6f0833a: Release the coordinated ChELL stack with deterministic `/proc` topology progress, complete visible-feed indexing, safe warm-up query gating, remote one-shot command completion, and refreshed daemon documentation.
- Updated dependencies [6f0833a]
  - @fnndsc/cumin@3.8.1
  - @fnndsc/salsa@3.5.1
  - @fnndsc/chili@3.6.1
  - @fnndsc/brasa@0.9.2
  - @fnndsc/calypso@0.4.3

## 5.2.2

### Patch Changes

- 71a6cd4: Route a pipeline executable's bare `--signalflow` flag to SignalFlow diagram output and provide contextual help for dynamic pipeline commands. Keep final-segment redirection on the originating surface, propagate remote pipe-segment failures back to the engine, and prevent remote command errors from terminating the interactive ChELL client. Daemon mode now reports shared startup cache warming and publishes its listening berth only after engine readiness. Consistently document `signalflow -` for stdin rendering.
- Updated dependencies [71a6cd4]
  - @fnndsc/brasa@0.9.1
  - @fnndsc/calypso@0.4.2

## 5.2.1

### Patch Changes

- Updated dependencies [e630f79]
- Updated dependencies [e630f79]
  - @fnndsc/brasa@0.9.0
  - @fnndsc/cumin@3.8.0
  - @fnndsc/salsa@3.5.0
  - @fnndsc/calypso@0.4.1

## 5.2.0

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

### Patch Changes

- Updated dependencies [50d0680]
  - @fnndsc/calypso@0.4.0

## 5.1.4

### Patch Changes

- Updated dependencies [8ac7ef9]
  - @fnndsc/brasa@0.8.0
  - @fnndsc/calypso@0.3.7

## 5.1.3

### Patch Changes

- Updated dependencies [a1f6694]
- Updated dependencies [01ab743]
- Updated dependencies [b8ae635]
- Updated dependencies [ca63e8b]
  - @fnndsc/cumin@3.7.0
  - @fnndsc/salsa@3.4.0
  - @fnndsc/brasa@0.7.0
  - @fnndsc/calypso@0.3.6

## 5.1.2

### Patch Changes

- 4043a96: Align the `pacs pull` per-series progress bars. The series name and status are now rendered as fixed-width columns — the name column grows to the widest series and already-drawn bars (including finished ones) re-pad to match — so every progress bar starts at the same column and the bars line up vertically instead of stepping in and out with each series' name and status length.
- Updated dependencies [e5a30f7]
  - @fnndsc/brasa@0.6.0
  - @fnndsc/calypso@0.3.5

## 5.1.1

### Patch Changes

- Updated dependencies [c2087d0]
  - @fnndsc/brasa@0.5.0
  - @fnndsc/calypso@0.3.4

## 5.1.0

### Minor Changes

- 880d37a: `chell --version` reported brasa's version in place of chell's: the version module moved into brasa during the engine split but still read its own `package.json` as "chell", so it printed brasa's number. It now resolves every package by name (reading brasa's own directly) and reports the full stack — chell, brasa, chili, salsa, cumin, calypso — with versions aligned in a column. A new `chell --info` flag prints a role-grouped table (surfaces / engine / layers) of each package, its full name, and version. The version report, the `--info` table, and the boot panel all draw from a single source of truth in brasa (`stackInfo_get`), and the standalone binary inlines every stack version at build time.

### Patch Changes

- Updated dependencies [512e14f]
- Updated dependencies [880d37a]
- Updated dependencies [e43f42a]
  - @fnndsc/brasa@0.4.0
  - @fnndsc/chili@3.6.0
  - @fnndsc/calypso@0.3.3

## 5.0.2

### Patch Changes

- Updated dependencies [a0d3df5]
- Updated dependencies [a0d3df5]
  - @fnndsc/brasa@0.3.0
  - @fnndsc/chili@3.5.0
  - @fnndsc/calypso@0.3.2

## 5.0.1

### Patch Changes

- Updated dependencies [d69b086]
- Updated dependencies [d69b086]
  - @fnndsc/brasa@0.2.0
  - @fnndsc/chili@3.4.0
  - @fnndsc/calypso@0.3.1

## 5.0.0

### Major Changes

- c824000: chell is now the CLI surface over the new `@fnndsc/brasa` engine package. The shell engine (parser, dispatch, pipes, builtins, session, output) was lifted into brasa; chell keeps the readline REPL, terminal rendering, and prompt themes.

  Breaking: the `calypso` daemon binary is no longer provided by chell — it now ships with `@fnndsc/calypso`. Install that package to run the daemon (`chell --daemon` continues to work). Prompt themes now render per-surface from a pushed context rather than as a server-rendered string.

### Patch Changes

- Updated dependencies [c824000]
  - @fnndsc/calypso@0.3.0

## 4.4.0

### Minor Changes

- 55d2dab: Capture bridge for legacy printing builtins: `CaptureSink` (data and err buffered, status passed live so spinners stay visible) and `printingHandler_wrap`, which runs a printing handler under capture and returns its output as an envelope with status derived from the exit code. The resource-group commands (feed, plugin, compute, tag, group, pluginmeta, plugininstance, workflow, files, links, dirs, context, parametersofplugin, and aliases) now flow through the bridge: envelope semantics, identical bytes, typed models deferred until a structural consumer exists.
- aa81b0a: Add the error stream to the envelope contract and convert the first fs builtins. `CommandEnvelope` gains `renderedErr` (printable stderr text, ANSI permitted), keeping the error stream separate from pipeable data; `envelope_error` accepts it as a third argument; the structured `errors` field is machine-facing and no longer presented by delivery. chell's `OutputSink` gains `err_write` (stdout sink routes to stderr; capture sink passes through uncaptured, matching today's pipe semantics). Builtins converted: `cd`, `mkdir`, `touch` (models `fs.cwd`, `fs.mkdir`, `fs.touch`), rendered and error-stream bytes identical to the previous behavior.
- 2f2f6d3: `calypso` is now its own command. It is `chell --daemon` under a dedicated name — hosting one engine over a loopback WebSocket for remote surfaces to attach to — and shares chell's entire connection surface: the `user@url` shorthand, `--user`, and the hidden password prompt all work exactly as they do for `chell` (bare `calypso` inherits the saved session; `calypso rudolphpienaar@http://cube/api/v1/` prompts and connects at startup). Attach a surface with `chell --remote`. The DEP0169 warning suppression shared by both entry points moved into `core/warnings.ts`, and `chell_start` now accepts an argv override so the `calypso` entry can force daemon mode without duplicating the bootstrap.
- 30a3e1e: Interactivity over the wire: a builtin that prompts during a remote command now reaches the surface running it. The contract gains a `prompt` request (daemon→surface, with hidden-input support) and a `promptAnswer` reply (surface→daemon). The daemon serializes execution across the whole session so a mid-command prompt has one unambiguous target, and exposes an input broker (`prompt_current`) the host wires into its `Surface`; the `chell --daemon` launcher installs a surface whose `prompt` delegates to it, so `repl_question` (passwords, confirmations, the plugin admin flow, the prompt configurator) works over the wire unchanged. The `chell --remote` client answers incoming prompt requests from its own terminal (hidden when asked) and replies. Completion already round-trips from the earlier daemon work; the themed pushed prompt string and client-side pipe-segment execution remain follow-ups.
- 93e604f: Run pipeline segments on the surface, never on the daemon host. Segment execution becomes a surface capability: the `Surface` gains `pipeSegments` (a capability flag) and a `pipeSegment(command, input)` method. The local CLI runs segments in-process exactly as before (byte-identical); the daemon's surface routes them over the wire (new `pipe`/`pipeResult` messages, base64 for the bytes) to the surface running the command, which runs them on its own machine — so a pipeline like `ls | grep foo` never spawns anything on the daemon host, closing that attack surface. A surface without the capability (a browser) fails such pipelines with a clear message. Completes the interactivity work: prompts, completion, the pushed prompt string, and pipe segments all now work over the wire.
- f492dd9: Push the themed prompt string to remote surfaces. Only the daemon holds the session context the prompt renders, so it renders the prompt and pushes it (a new `promptline` message) to every surface on attach and after each command — the context may have changed. A surface prints what it receives, so prompt themes look identical whether the session is local or remote. chell factors prompt rendering into a shared `sessionPrompt_render` used by both the local REPL and the daemon's `promptProvider`; the `chell --remote` client renders the latest pushed prompt (falling back to a fixed string until the first push), replacing the placeholder prompt it showed before.
- 7cee888: The surface owns the local editor, so `edit` works over the wire. The `Surface` gains a `localEdit(content, extension)` method (resolving the flag-only deferral from the prompt-capability work): the CLI surface backs it with the temp-file-and-`$EDITOR` mechanics that used to live in the `edit` builtin, and the daemon backs it by routing to the surface running the command (new `edit`/`editResult` messages + an `edit_current` broker) so the operator's own editor opens, never one on the daemon host. The `edit` builtin no longer touches processes or temp files for editing — it fetches the file, hands the content to `surface.localEdit`, and uploads the result; `chell --remote` opens the client's editor. A surface without the `localEdit` capability (a browser) fails `edit` with a clear message.
- 8bb7ec5: Add `chell --daemon` and `chell --remote`: the same REPL now drives either an in-process engine or a CALYPSO daemon over the wire. `chell --daemon` hosts the connected engine behind a daemon (forcing color on, silencing the daemon's own console, and advertising its URL + attach token in a user-only-readable discovery file for same-user attach); `chell --remote` discovers that daemon and attaches as a surface. The transport swap is a new `RemoteEngine` that implements the engine interface over the WebSocket contract and delivers received envelopes to the sink exactly as the in-process engine delivers live, so the REPL is unchanged — proving the sibling-surfaces topology (two remote shells on one daemon each see the other's commands via the session bus). This is the first place chell depends on `@fnndsc/calypso`.
- 2099ff6: Make the error stack async-context aware and drain it per command. cumin's `errorStack` gains `scope_run` (run work against an isolated stack), `checkpoint_mark`, and `checkpoint_drain`: fire-and-forget background work (topology warm-up, background cache refresh) now runs inside its own scope so its error traffic cannot land in a concurrent foreground command's drain window. chell's dispatch checkpoints the stack before each command and drains anything pushed above the checkpoint into the envelope's `errors` field, escalating status to `error` when a genuine error was left on the stack — a reliable per-command failure signal that also retires the exit-code-delta status heuristic's blind spot (a later failing batch segment no longer reads `ok`). CLI behavior is byte-identical.
- 60cbd8e: Extract the engine facade (`engine_create`, `line_execute`, `line_complete`, `ChellEngine`): line-level orchestration — shell escape, semicolon batching, redirects, pipes — now lives in `core/engine.ts` and yields one `CommandEnvelope` per executed command, while output continues to reach the active sink live. The REPL shrinks to a thin host (read line → engine → sink), dispatch gains envelope-producing execution (`command_dispatchEnvelope`, `command_executeToEnvelope`, `redirect_execute`, `pipe_execute`), and the unknown-command chili fallback now runs through the capture bridge so it too produces envelopes. Observable CLI behavior is byte-identical.
- 363bff0: Bridge second batch of printing builtins into envelopes (ls, tree, du, help, proc, logout, cubepath, query). Unbridge plugin: its add flow prompts for admin credentials through readline, which capture would make invisible; it stays a direct printer until the prompt capability lands with the engine facade.
- d302511: Introduce the output sink seam (`OutputSink`, `StdoutSink`, `BufferSink`, `envelope_deliver`, `envelopeHandler_wrap`): command output now leaves the engine through a host-installed sink instead of builtins assuming a terminal. The REPL installs a stdout sink, preserving CLI behavior exactly. First builtins converted to envelope returns (`pwd`, `whoami`, `whereami`), registered in the dispatch table through the compatibility wrapper and exposed raw via the new `ENVELOPE_HANDLERS` registry for envelope-aware hosts. See docs/calypso.adoc.
- 99c65e1: Convert timing, physicalmode, and debug builtins to envelope returns (typed models `sys.timing`, `sys.physicalMode`, `sys.debug`; rendered text byte-identical). Rename the sink channel methods to the project's RPN convention: `OutputSink.data_write` and `OutputSink.status_write`.
- b90a9cc: Pipes and redirects consume envelopes. The capture seam now feeds pipe chains and redirect targets from envelope-speaking commands' rendered text with ANSI stripped (plain pipes, the documented deviation from historical escape-byte leakage), passes error-stream text live to stderr, and still captures direct stdout writers such as binary cat. Legacy printing commands keep the old capture path unchanged.
- 5a2c448: Make interactivity a declared surface capability. A new surface seam (`core/surface.ts`) is the input-side counterpart to the output sink: a host installs a `Surface` that declares what interaction it can offer (`hiddenInput`, `localEdit`, `tty`) and backs prompting, and a builtin can require a capability via `capability_require` and fail with a clear message instead of hanging on a standard input that is not there. The CLI host installs a readline-backed surface (`core/cliSurface.ts`) — persistent on the REPL's interface, one-shot in execute/script modes — preserving the single-readline, no-echo-leak discipline. `question.ts`'s `repl_question` / `repl_questionHidden` now delegate to the active surface (salsa's admin-prompt flow and the prompt builtin are unchanged), and the `edit` builtin declares its need for `localEdit`. CLI behavior is byte-identical.
- 657311f: Convert cat to envelope returns (model `fs.cat` with per-file outcomes; text content buffered into rendered, binary content streamed with backpressure as before, auto-detection notice emitted live on the err channel so it precedes the bytes). Route the spinner through the sink's status channel: byte-identical on a terminal today, and positioned so transient frames never enter envelopes, pipes, or remote data streams.
- 2f2f6d3: Add a `version` command inside the shell. Typing `version` at the chell prompt (or `chell -c version`, and over a CALYPSO daemon via `chell --remote`) now prints the same stack report as `chell --version` — chell plus the chili/salsa/cumin layers — as a typed `sys.version` envelope, instead of falling through to chili as an unknown command. The version-report logic that both `--version` and the boot panel already shared moved into `core/version.ts` so the new command reuses it rather than duplicating the package.json loading.
- afde0e8: Convert cp, mv, and rm builtins to envelope returns (models `fs.cp`, `fs.mv`, `fs.rm` with per-target outcomes; rendered and error-stream bytes identical). Interactive `rm -i` streams live through the sink so confirmation prompts stay in sequence; non-interactive output is buffered into the envelope.

### Patch Changes

- 2f2f6d3: Fix `exit` from a remote surface tearing down the whole CALYPSO daemon. The REPL now treats `exit` as a shell-quit at the surface layer (closing readline) instead of forwarding it to the engine; for a `chell --remote` surface this detaches the client while the daemon — and any other attached surfaces — keep running. Previously `exit` reached the daemon's dispatch and called `process.exit`, killing every surface. Local interactive `exit` is unchanged apart from now printing the same goodbye line as Ctrl-D.
- Updated dependencies [aa81b0a]
- Updated dependencies [f8e0233]
- Updated dependencies [30a3e1e]
- Updated dependencies [93e604f]
- Updated dependencies [f492dd9]
- Updated dependencies [7cee888]
- Updated dependencies [e293d97]
- Updated dependencies [38df08f]
- Updated dependencies [2099ff6]
- Updated dependencies [c47ff22]
  - @fnndsc/cumin@3.5.0
  - @fnndsc/calypso@0.2.0

## 4.3.2

### Patch Changes

- Example accession numbers in help text replaced with clearly fake values.
- Updated dependencies
  - @fnndsc/salsa@3.2.6

## 4.3.1

### Patch Changes

- PACS query polish: a zero-match query completes in seconds through the "no studies found" path instead of spamming per-poll errors and riding the 60s timeout; browse/pull hints are suppressed when nothing matched; the spinner erases to end-of-line so shorter status messages no longer show the tail of longer ones.

## 4.3.0

### Minor Changes

- chell expands `$NAME` / `${NAME}` environment references in command arguments, making scripts parameterizable. `--version` now reports the chili/salsa/cumin versions in use. Fixes: `pull` re-pull of a series (query title collision), `pull` with a query expression (CWD was corrupting the first DICOM key), silent `query` failures now print the error stack, and `-e` aborts `-f` scripts with a non-zero exit when a command fails. New `exemplars/` reference programs and scripts (repo only, not packaged).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @fnndsc/chili@3.3.0
  - @fnndsc/cumin@3.4.0

## 4.2.12

### Patch Changes

- Test coverage lock-in: global coverage ratchets raised and a 60% per-file floor enforced in CI. No runtime changes.
- Updated dependencies
- Updated dependencies
  - @fnndsc/cumin@3.3.0
  - @fnndsc/salsa@3.2.5
  - @fnndsc/chili@3.2.6
