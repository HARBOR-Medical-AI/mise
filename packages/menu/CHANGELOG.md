# @fnndsc/menu

## 0.32.0

### Minor Changes

- f6790b6: The stratus wire names say cluster, not domain. They are `ClusterSummary`, `ClustersModel`, `ClusterSizeModel`, `ClusterSpecModel`, `ClusterStep`, `CLUSTER_CONDITIONS`, the model kinds `stratus.clusters` and `stratus.cluster.size`, and the event `stratus.cluster.state`.

## 0.31.1

### Patch Changes

- 4568c64: A domain summary's origin may be `found`: in the tenancy by its tag, not adopted (#1286).

## 0.31.0

### Minor Changes

- 0efbb7c: A PULL in ARGUS runs in the background: the console and every other press stay yours while a retrieve goes on. The press sends `pull … &`; the badges follow it as before, each running joblet is a row on the LANE instrument with a STOP that types `kill %N`, the console prints when one starts, ends or waits for an answer, and RESTART names the joblets it would end (#1273).

  A joblet relays its progress, and any model it answers with, to the surface it came from; its task carries its progress. The heartbeat's lane lists the running joblets, calypso answers `GET /joblets` (token-gated), and a porter login that finds a session on older code keeps it, rather than restart it, while joblets run.

- b8bc519: A line ended with `&` runs in the background as a joblet, so a long pull no longer holds the console it was typed in. It is kept at `/proc/joblets/<N>` with its output in its log; its surface hears `[1] … &` when it starts and `[1]+ Done`, `Failed (exit N): …` or `Stopped` when it ends. `joblets` lists them, `fg %1` answers what one waits on and follows it, `kill %1` and `wait %1` stop and follow one. A joblet stands where its line was typed with that line's variables, its own `cd`s and assignments staying inside it, and holds what its line changes in the same lane as every line; one that needs an answer pauses until someone brings it forward (#1273).

  Every session's runner now carries the core's `joblets` source (a runner source may be `ungated`, needing no tier, and words its own end `notice`, sent to the surface in `data.origin`). An ambient `envelope` event may name its `origin`; calypso sends it to that surface while it is attached. A `Surface` may offer `hold(holds)`, which calypso answers from its lane (`hold_take`). `cwdScope_run` takes a start folder, and a `cd` under one stays in it.

### Patch Changes

- 41769da: Each surface keeps its own last answer, so `@3` counts the listing that surface read. A listing read in a browser no longer renumbers the rows a console is about to act on: calypso hands every line its surface as origin, the kernel keeps one answer per origin, and a numbering goes only to the surface whose line listed. A surface that leaves takes its answer with it; one that attaches has listed nothing yet (#1273).

## 0.30.0

### Minor Changes

- fd1711f: A domain whose build stopped part way reads STOPPED, not SIZING · NOTHING BUILT.

  The new condition covers steps done with none running and the domain not up. The line under it reads PLANNED · NOTHING BILLED when the next step is the first that bills, as after NO at the billing question, and NOT FINISHED otherwise.

- 4bc9d87: The dashboard and every other line keep working while a long build is being followed.

  Following a task (`domain build`, `wait`) steps out of the session's turn between the task's lines, as a question already did, so a pane's reads run meanwhile; STOP still reaches the follow. A line whose browser has closed can now be stopped from any surface. A line typed in one browser never opens on another.

- 02c20bf: Every function name now says what it does: the 462 that put a preposition where the verb goes are renamed (#1227).

  The style guide names a function `<subject>[Qualifier]_<verb>[Adverb]`. Names such as `answerRows_of`, `seriesUID_ofPath`, `options_toParams` and `ask_onPane` put a preposition in the verb's place, which names the result without saying whether the function derives, parses, builds or renders it. They are now `answerRows_derive`, `seriesUID_parse`, `options_convertToParams` and `askOnPane_await`. A preposition may still qualify the verb (`x_readFromCache`) or the object (`askOnPane_await`); it may not start the method.

  `npm run lint:rpn` (`scripts/rpn-prepositions.mjs`) refuses a function, `const` function or underscored method whose method is, or starts with, `of`, `to`, `with`, `from`, `for`, `by`, `as`, `in`, `on` or `at`, and CI runs it. The exported names change with no aliases kept: nothing outside this repository imports them.

- 55e2041: A new domain finds its DNS zone in the tenancy: the only one by default, else one chosen on SIZE or named.

  `domain new` and `domain size` read the tenancy's DNS zones; a named `--base-domain` must be one of them, and with several and none named `domain new` refuses, listing them. The size model carries `dnsZones`. In ARGUS, SIZE shows a ZONE choice and COMMIT stays dark until a zone is set.

## 0.29.0

### Minor Changes

- e1d052d: ARGUS shows the kernel's cohort instead of keeping its own copy. Its GATHER, REMOVE, CLEAR, name and CREATE FEED presses send `gather add|remove|clear|name|feed`, and the band and the GATHER pane redraw from the `gather.cohort` model those verbs answer with, including a line typed at any chell on the session. ARGUS no longer writes `~/gather/current.json`.

  The kernel now fills in what the surface used to supply. `gather add` on a PACS path takes the series' description, modality, file count, patient and study from the query answer the path names (from the PACS mount's cache, so at most one CUBE read per query). A gathered folder is imagery when its name or place says it is a series, by the rule ARGUS's viewer uses, which now lives in `@fnndsc/menu` as `seriesFolder_is`. `gather feed [--title T]` makes the cohort's feed: series still at the PACS are pulled first, then one feed is rooted on every member, folders included. `gather name` answers with the cohort, and so does a `pull` that noted landed folders on it.

  `PacsVfsProvider.queryResult_fetch` is public, and `vfsDispatcher.pacs` names the PACS mount. `pacsQueryModel_build` moved to `builtins/net/query.model.ts` and is still exported from `query.ts`.

- 05ec948: A domain now says everything the TD controller draws: where it stands in one word, what it costs, what is refused on it. `domain status` answers each domain with its condition (SIZING, ASKING, BUILDING, UP, SERVING, FAILED, GONE), whether it bills, whether it was built here, adopted or read from a checkout, what is refused on it and why, its spec, each step with its times, the build's running task, the last plan counted with drift apart, and the last verify check by check. `domain build` shows its domain as a `stratus.domain.state` event at its start, on each line it logs, and before each question. `domain size [--family F]` reads what a new domain is sized against: each zone's free cores and memory, the family's shape and price, and the starting spec. `domain verify` keeps its checks beside the plan, and `domain <name>` reads that one domain.
- 46bc80d: Zod moves to 4.6.7: zod 3 carries a high-severity advisory with no 3.x fix, which failed every build's audit. The advisory is GHSA-mrhx-c7xc-m3w5, memory exhaustion while validating oversized constrained collections. The wire schemas read as before: `.catch` fallbacks, `.default` values, `.passthrough()` and the recursive DICOM tag parse were checked against zod 4. `dicomTagSchema` is typed `z.ZodType<DicomTag, unknown>`; schemas exported from `@fnndsc/menu` are zod 4 schemas, so code that names zod 3's types against them (`ZodTypeDef`, `SafeParseReturnType`) has to move too. A boundary reason now renders a symbol in a path instead of throwing. salsa's nested lockfile, which only the audit reads, overrides zod until a `@fnndsc/menu` built on zod 4 is published, and is back in step with salsa's `package.json`.

## 0.28.0

### Minor Changes

- 49ccdfd: The prompt context gains backend-neutral segments a backend fills in order and a surface draws in order.

  Each segment is a key, a label, a value and a tone.

  A ChRIS daemon sends none and its prompt is unchanged; an older surface ignores them. The tones are leader, place, identity, path, work, note and alert; a surface maps each to its own palette, so no colour crosses the wire (docs/stratus.adoc, D9). Beside the brain, `@fnndsc/menu/logo/td` renders the Trusted Domain mark, the blue North Star in the driver's ring, for the stratus composition's splash.

- 49501d4: A surface can now say whether the session may start jobs that bill, with the optional tasks capability.
- 14f8fc1: A domain's summary can now carry what it costs an hour and so far, at list price, in the optional cost field.
- dcdc6cd: A stratus dashboard shows DOMAINS (each domain's last build step) and CAPACITY (what each zone has free).

  DOMAINS reads `domain status` and CAPACITY reads the new `capacity` command, through the wire's new `stratus.domains` and `stratus.capacity` models (menu). `capacity [<family>…]` lists, for the shape families named or those the domains' specs name, each limit their shapes draw on per zone, permitted and free; a shape now names its limit service. A domain with a step gone wrong shows in red.

## 0.27.0

### Minor Changes

- 21649d1: A running command can show its surface a typed event, and trek shows its state at every Command: prompt.

  `OutputSink` gains `event_write(kind, data)`, the wire gains the `event` message (daemon to the command's origin surface, live only), and the ARGUS client hands events to its host. bsd-trek's `TrekTerminal` gains `state_show`, called with a deep copy of the whole game state before each command is asked for; the session's `trek` sends it as `games.trek.state`. The recorded C games replay unchanged; a terminal that only prints leaves `state_show` out. This is what a bridge that draws the game reads, instead of the printed scans.

## 0.26.0

### Minor Changes

- fb6813d: Any running command can now be stopped, with Ctrl-C or the console's new STOP capsule. A host process it started is killed, and a command that does not end when asked is abandoned after three seconds so the session is free again. A chell that disconnects stops its command, and Ctrl-C reaches a host program in the terminal.

## 0.25.0

### Minor Changes

- 66f1956: sl, cmatrix, rain, asciiquarium, tetris and snake play in the terminal they are typed in; --pane draws them in ARGUS's GAMES pane. The programs move to `@fnndsc/menu/games` so chell and ARGUS run the same ones; chell takes the screen (alternate screen, raw keys, the console's hues) and gives it back on q, Esc or Ctrl-C, and marks the console `playing` meanwhile. The transcript console, with no screen to play on, keeps the pane.

## 0.24.0

### Minor Changes

- 90b7688: The ARGUS console is now a terminal by default wherever the daemon offers one; TRANSCRIPT on its drawer goes back. A browser's terminal can no longer run anything on the daemon's host. Its chell used to declare that it could, so `!cmd`, host pipe segments, `edit` and `download` would have run on the daemon host. These requests now go to the browser that owns the terminal, which refuses `!` and host pipes by name, opens its own editor pane and saves downloads in the browser. Questions stay in the terminal. A terminal's chell marks for the page whether it is at its prompt, running a command or asking, and the page shows it as `data-terminal-state`. Ctrl-C at an open question now abandons it, so the command that asked is told and ends. Commands typed in the page's own terminal move the page as its console's commands always did: a game opens the GAMES pane, `say` speaks and a `cd` re-lists the files pane. An answered pane question is recorded in the terminal's scrollback. A line the terminal wrapped reads back as one line. The smoke suite drives either console (`SMOKE_CONSOLE=terminal|transcript`), and the nightly gains a transcript lane (#1125).
- 554fd24: The ARGUS console can be a terminal: press TERMINAL on the console's drawer, or type `console terminal`. xterm.js then draws the chell the daemon runs for this page, so the browser console is the same shell as a terminal's, with its own prompt, line editing, history, completion and questions in line with their output. It uses the console's font and colours, and a reload reattaches the same terminal. Touch devices get a key row (ESC, TAB, CTRL, arrows). The choice is remembered per device. A daemon that could not build node-pty offers no capsule, and the console stays the transcript. What ARGUS itself runs, such as a pressed DELETE's `rm -i` with its output and result, is mirrored into the terminal, and the daemon no longer echoes that command to the page's own consoles, so nothing prints twice. A pressed verb's question still stands on its pane, console open or closed, and a question with no pane is shown on a sheet over the stage. The transcript stays the default until the smoke drives the terminal (#1125).
- 6bde343: ARGUS's own words now work from any chell on the session, including `desktop show`, `view runs` and `dag census on`. A browser declares the subjects its language claims (whole subjects such as `dag`, `desktop` and `pane`, and only listed verbs of shared ones such as `file open` and `help keys`). The daemon then routes a single command in a claimed subject to that browser instead of the engine, and the chell prints the browser's answer. The browser that owns a chell's terminal answers first, then the most recently active one. With no browser attached, a subject claimed whole is refused by name, and a shared subject stays the session's. Tab completion offers the claimed words. A browser can also send a note to its own consoles, printed above the line being typed. A terminal's chell now tells the daemon which terminal it draws. This is the groundwork for ARGUS's console becoming a terminal (#1125).

## 0.23.0

### Minor Changes

- c73c81b: The daemon offers terminals: a browser's console can be a real chell, run under a pseudo-terminal. A surface sends `terminalOpen` with its size and receives the terminal's bytes as `terminalData`; it sends keystrokes back as `terminalInput`, and size changes as `terminalResize`. Each terminal is the same `chell --remote` a shell would run, attached back to this daemon over loopback. A terminal outlives the socket that opened it: opening it again by its id replays up to about 1 MB of recent output and carries on, even mid-command or mid-question. A terminal nobody is attached to closes after 15 minutes, and `exit` closes it at once. The pseudo-terminal comes from `node-pty` 1.1.0, an optional dependency compiled at install. A daemon where it did not build says `terminals: false` on attach and refuses `terminalOpen` with the reason. ARGUS's console moves onto this in the next release (#1125).
- 1a2a0d0: An open question shows across the session: `? N WAITING` on the ARGUS status strip, and `? N waiting` in chell's prompt. The daemon counts the questions open on every surface: they ride the heartbeat's lane (which surface asked what, and for how long) and every prompt context. ARGUS names each one in the strip's title and adds an ASKING row to the lane instrument; `who` says what each surface is waiting on. A question no longer freezes the session, so this is how a game paused in another tab, or a confirm left in a terminal, is not forgotten (#1128).

## 0.22.2

### Patch Changes

- 9065319: A feed shared with you is marked NEW until you open it, across logins (#1065). RUNS leads with a NEW SINCE YOUR LAST VISIT block, each row marked with who shared it, and the bar counts them. Opening a feed takes its mark off, and CLEAR NEW takes them all. `proc feeds --new` lists them and `proc seen` clears them. Your own feeds and public feeds are never marked.

## 0.22.1

### Patch Changes

- a0f0160: Jump to a feed or a node by its number (#1061). `proc jump 639204` goes to the node, `proc jump feed_4389` to the feed, asking CUBE for anything shared since the roster was walked. A bare number that is both a feed and a node is never guessed: chell names both, and RUNS asks which. RUNS gains JUMP TO on the roster frame: it asks for the number, enters the feed, and selects the node once the graph is drawn, without moving the console's working directory.

## 0.22.0

### Minor Changes

- 183aa7d: Nothing changes on screen: the daemon's attach answer names the session's backend, and ARGUS reads it (#985). menu's `attached` message gains an optional `backend`; calypso fills it from the backend it hosts (`chris`, `null`). ARGUS's `attachBackend_get` reads it, and an older daemon without the field is ChRIS, so a new ARGUS against an old calypso draws what it always drew.
- 27f3021: Nothing changes at the prompt: the engine reads its generic pieces from their own homes, not from cumin (#1001). menu gains the envelope helpers `envelope_ok`, `envelope_error` and `envelope_isOk`, beside the `CommandEnvelope` they make; cumin keeps its own for its callers. brasa reads `Result` and the error stack from fond and the envelope from menu. The error stack is still the one instance cumin shares. The core command group imports its builtins module by module rather than through the builtins barrel. `lint:core-deps` drops from 14 to 9.
- 6752575: Nothing changes at the prompt: a backend brings its long-running steps as tasks, shown under `/proc/<source>` (#983). menu's `Task` has an id, a label, a state (`queued`, `running`, `done`, `failed`, `cancelled`), progress, start and end times and a log tail. A backend's `tasks` lists its sources; one that brings no mount of its own is shown by the core as a folder per task and a file per field (label, state, progress, started, ended, log), its whole log where the source keeps one. The null backend takes task sources too, and CI's core boot lists and reads a fake one. ChRIS's `/proc/jobs` is unchanged; it becomes a source in the next step.

## 0.21.0

### Minor Changes

- 8d15909: Nothing changes for chell, ARGUS or porter users: the engine's output and surface contract now lives in menu. `OutputSink`, `Surface` and their companions are served as `@fnndsc/menu/surface`; brasa re-exports them, and the engine installs its own sink and surface. `BrasaEngine` gains required `sink_install` and `surface_install`, so code that implements it must add both.

## 0.20.0

### Minor Changes

- 5bb17f6: Nothing changes for chell, ARGUS or porter users: a listing entry's shape now belongs to menu, with an open type. `ListingItem` and `listingItemSchema` are menu's, so a backend can list its own kinds beside `dir`, `file`, `link` and `vfs`; fond's `VFSItem.type` opens the same way, and chili re-exports the type.

## 0.19.0

### Minor Changes

- 5a0eef5: The session.notes model: what the installed releases changed, release by release, for a surface to list.

## 0.18.0

### Minor Changes

- 73c0087: A PACS series that arrives is no longer shown as ERROR. The retrieve watch always asks CUBE before it gives up on a series (with no retries, the default, it never did), a series not seen to finish and not yet in CUBE is UNCONFIRMED with its reason rather than ERROR, and the watch waits a minute (not fifteen seconds) for a PACS slow to begin. Progress messages carry an optional `reason`, shown on the ARGUS badge and in pull's summary. In ARGUS a fresh answer finding a series home in CUBE replaces a pull that ended badly, and a pull waiting on its first file paces again instead of drawing a still empty bar. After twenty seconds of silence a pull checks CUBE and then asks whether to keep waiting (a surface that cannot be asked waits a minute). ARGUS runs the PACS pane's pull and query as the operator's own acts rather than instrument traffic, so they can ask.

## 0.17.0

### Minor Changes

- 51315ec: The calypso daemon knows when it is stale. It fingerprints its own packages' code (version and compiled scripts' content) when it starts, reads the fingerprint again on every attach and once a minute, says `stale` in its attach ack, and pushes a `stale` message when the answer flips. ARGUS says CALYPSO DAEMON OUT OF DATE only when the daemon says so, so an ARGUS-only release no longer alarms every running daemon; an open ARGUS learns of an upgrade within a minute. A daemon too old to report `stale` falls back to the build-stamp comparison.
- 33e4f1d: A session restarts from its own browser and stays logged in. Porter's new `POST /restart` (cookie-gated: only the cookie's own session) tells the old calypso daemon why, ends it, and boots a fresh one with chell's new `--saved-token` login, which uses the token the identity saved and refuses rather than come up offline. The browser follows the boot on the greeter; a refused saved token ends at the door with the reason. On SIGTERM the daemon sends `closing` (restart, end or stop) to every surface before it exits, and a remote chell prints why it went. `porter --end` leaves `end` as the reason.
- fe4b6b4: The calypso daemon is restarted by its own operator, behind a door. A RESTART pill stands beside LOG OUT, and the out-of-date notice's cure "Restart the calypso daemon" is a control. Both ask first in the notice's spot ("Restart the calypso daemon? You'll stay logged in; …"), naming what a restart would cut off right now: the running command, unsaved edits, other attached browsers and chells. YES asks the door to restart and follows the greeter back in; another ARGUS on the session says why it dropped and follows on its own. The daemon's heartbeat now lists the attached surfaces (id and kind) and its attach ack gives each surface its own id.

## 0.16.0

### Minor Changes

- 685ed59: ARGUS and the calypso daemon say when they are different builds. ARGUS's build writes its stamp into the bundle; the calypso daemon reads it once at start and reports it in its attach ack (`stack.surface`, optional in the wire schema). When ARGUS's own stamp differs, it says which is older and what to restart — on the status strip, in a dismissible notice, and on the console: "ARGUS is newer than the calypso daemon, so some controls won't work. Restart the calypso daemon." or "ARGUS is older than the calypso daemon. Refresh to load the new ARGUS." A remote chell prints one line at attach when its build differs from the daemon's.

## 0.15.0

### Minor Changes

- 2826f2b: A text file offers EDIT (#831, slice 3b). A file row whose extension is not on the binary list offers EDIT in ARGUS, a feed's note seen through `/proc` included; it runs `edit '<path>'` as a visible line and the kernel opens the editor pane, asking first for a file of a megabyte or more. The binary list moved into the contract package (`EDIT_BINARY_EXTENSIONS`, `path_isEditable`, `EDIT_CONFIRM_BYTES` in @fnndsc/menu), read by the kernel's `edit` for its refusal and by the surface for its offer, so the two cannot disagree. `feed note edit` help now says it edits in the surface's editor. New `docs/cube-feed-coverage.adoc`: each part of a CUBE feed, the kernel verb or path that reaches it, and the known gaps (rename, group permissions, revoking a grant, making a feed private again).
- c1cf57e: An edit crosses the wire to a browser (#831, slice 2). The daemon's `edit` request now names the file being edited (`path`), and a surface may answer `opened`: it took the file into an editor that stays open, so the command saves nothing and says `(opened in the editor)`; each save made in that editor will run as its own command line. The argus client hands an edit to a host editor hook and answers at once that it opened, or refuses in words when it has none (the hook is installed by the editor pane, slice 3). `feed note edit N` is now `edit /proc/jobs/feed_N/note`: a terminal's editor and a browser's pane open the same text and save it the same way, and the title is set with `feed note N --title`.
- 51da853: ARGUS shows and changes a feed's tags (#831, slice 4b). The kernel's roster model (`feed.list`) carries each feed's tags from the cached tags index (one read per tag, never per feed). The runs roster marks a feed with its tags after its title, in one theme hue; a press on a mark filters the roster by it (`tag:`, a new filter-only term in the listing façade), and its × on the indicated row takes it off. A feed row offers NOTE (the editor on `/proc/jobs/feed_N/note`) and TAG. TAG asks a new `choose` question: your tags as pills (the worn ones dimmed), a field for a new name, DONE to end; each pick runs `setfattr`, a new name `mkdir /proc/tags/<name>` first, all as visible lines, and the question comes back with the tag held. A graph on stage reads its feed's note and tags when entered and shows ADD NOTE or EDIT NOTE, TAG and the marks under BACK, re-read after an editor save. A note is never read for the roster (CUBE's feed list says nothing about notes: ChRIS_ultron_backEnd#737).

## 0.14.0

### Minor Changes

- 4864a34: `netstat`: the wire is a readout. The kernel keeps a ledger of every request it makes to CUBE (Node's diagnostics channels, nothing patched) — count since the session or the last reset, by endpoint family with time spent, the last few timed — and `netstat [-n <count>] [-r]` reads it as text and as the `net.stats` model.

## 0.13.0

### Minor Changes

- fbd3f0a: The session lays the universe out itself: once the index is whole the daemon runs orrery's engines for every layout in a worker thread and keeps the places (`proc layout <name>` reports `laying` progress meanwhile). orrery is published; `layoutInput_build` builds the engines' input one way for browser and session, and the universe graph builders live in `@fnndsc/menu`. ARGUS waits on the session's progress instead of settling the same space, keeps places only for the view on stage (SHAPES apart), redraws a view already seen where it stood, and gives the session only default-physics places.
- fbd3f0a: Data facts reader v2: a series in CUBE's PACS store is described by CUBE's own series record (asked once per patient) before any header is read, and each feed records `sourceFeed` when its data lies in another feed's output. Under DATA that lineage is drawn as a faint thread from the source feed's root (`joinFaint`: a thread, never a tube).

## 0.12.0

### Minor Changes

- d1da8ac: `proc universe` carries what each feed's data is (`data`: format, and for DICOM modality and series description) once the index has read it. The reader follows a copy job's links (to files and to folders), reads newest feeds first, four at a time, gives a feed that never answers 45 s before moving on, records a DICOM-named file whose header will not read as DICOM with the reason, and stamps each record with its reader's version so a better reader reads feeds again.
- 0f9ae74: The universe laid out once per identity: `proc layout <name>` answers where a surface last laid the universe out under a layout, and `proc layout put <name> <places>` keeps it beside the index checkpoint. ARGUS puts each settled layout and, in a browser that keeps none, draws from the session's copy at once, settling only feeds new since.
- d8e160c: `proc universe` says when each feed was made (`createdAt`, ISO 8601), the order a replay reveals the space in; a model from an older daemon reads it as empty.

## 0.11.0

### Minor Changes

- dac2d96: menu: the `session.motd` model — who arrived, feeds by scope, jobs by state, the failure rate, how far the index has come, and a fortune.

### Patch Changes

- 50f8a4e: menu: `errored` on a job group in the prompt's landings and in `proc.universe` (zero from an older daemon).
- c82f514: menu: `title` on a landed feed in the prompt context and on a `proc.universe` feed (empty from an older daemon).

## 0.10.0

### Minor Changes

- 8a8dc25: A patient answers to a number: `@PAT001`.

  A PACS answer asked of two patients showed `1` beside each — the patient level had no kind, so it counted itself dim per group. Patients are now a kind of their own: `PAT001`, `PAT002` in their own sequence, lit on the pane, and `pull @PAT001` or `gather add @PAT001` hands a verb every series of every study of theirs, as the row's own GATHER does. A patient has no path of its own, so its address is minted from what names it (`patientAddress_of`, in the wire package, the same string on both sides); a patient the PACS answered nothing for has nothing to hand and wears no number.

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

- 7bba167: The door hands a token: a session can be started by a front that already logged the operator in.

  Today a session is started by the operator, at a terminal, with a password: `chell user@url -p … --daemon`. A login front on a shared host — the porter, the display manager the browser surface needs — exchanges the password for a CUBE token itself and holds the token, never the password. This is the seam that lets it start a session with what it holds.

  - cumin `connection_connectWithToken({ user, url, token })`: proves the token against the server BEFORE writing anything, so a refusal leaves the saved context alone; never exits the process; the refusal travels in the outcome, not on the error stack.
  - brasa `sessionConnect_withToken(user, url, token)`: the headless connect beside `sessionConnect_fromSaved`, setting the context the way a credentialed boot does and leaving the working directory as it was.
  - chell `--auth-token-stdin`: the token comes in on stdin, one line, never on argv where `ps` shows it to the host. Refuses by name: without a `<user>@<url>`, beside `--password`, or with no line on the stream. The boot row reads `Connect  Connected to <url> (token)`.
  - chell `--daemon` off a TTY no longer spawns a console onto its pipe — a boot ends at a login only where there is a terminal to log in on; otherwise the daemon says so and keeps listening, as the standalone `calypso` binary already did.
  - menu `@fnndsc/menu/logo`: the mise brain and its frame renderer move from the kernel to the wire package, decoding with `atob` and touching no Node builtin, so a browser can draw the same brain a terminal boot does. brasa re-exports it; chell and calypso keep their import.

  Exemplar `14_tokenLogin` starts a daemon this way against a live CUBE, off a TTY, in isolated directories, and proves the Connect row and a live berth.

- 1c169d7: The greeter: the door answers at once, and a boot is watched rather than waited for.

  porter: `POST /login` no longer holds the browser for a cold boot. A session already up is entered directly; one that must boot sends the browser to `/greet/<key>`, where the mise brain wakes — the same frames a terminal boot draws, paced by the page — and the daemon's boot rows arrive beneath it as they are written, ANSI and all, from the boot stream. `ready` rests the brain and hands the browser to the session; `failed` says why and offers the door again. The login page wears the same shell with the brain at rest. The porter serves the two modules it draws with from the installed wire package (`/greeter/brain.js`, `/greeter/ansi.js`); a booting identity is pending in the registry and reaches its mount only when its berth answers.

  menu: `@fnndsc/menu/ansi` — the ANSI-to-HTML converter and the console palette, moved from the ARGUS console so a browser greeter renders a boot the way the console renders a transcript; argus keeps the DOM half and re-exports the rest.

- 43b9440: The space of everything run here: the wait is drawn with what is known, and UNIVERSE is a face.

  While the job index warms, RUNS-02 had nothing to show but a refusal and a moving figure. Now the session reports each feed as the index reads it — its jobs collapsed by plugin per place in its pipeline (a fan of three hundred conversions is one node of 300), with a status on every node — on the prompt context (`procWarmup.landed`), and the pane draws them as they arrive: every feed its own small DAG, floating free like molecules in a solution, counts as weight and status as hue, feeds of one pipeline shape pulled together by an unseen anchor so the space settles into constellations. Every node is real. When the index is whole the roster takes over, as before.

  `proc universe` answers the same picture from the cache at any time, whole or warming, and says which; the dashboard's UNIVERSE tile opens it on the RUNS canvas. A feed's status words are now the DAG's own (`finishedWithError`, `started`, …) wherever cumin derives them from counts, so a feed on a surface wears the hue its jobs would.

## 0.9.0

### Minor Changes

- 9cf2ea2: `image <path>`'s text reflection now carries a thumbnail of the middle slice, so a TTY sharing the session shows the picture, not only the facts. The kernel reads the slice's pixels (`dicomSlice_gray` in salsa, uncompressed transfer syntaxes via dcmjs), window/levels to 8-bit with MONOCHROME1 inverted, and box-downsamples to a cell grid; brasa renders it as an ASCII ramp on any pipe or ANSI truecolour half-blocks (`▀`) on a colour terminal. Colour is a new declared surface capability: ARGUS declares it (its DOM console renders ANSI), chell reads its own terminal through chalk, a bare pipe gets the ramp. Compressed pixels say so in one line rather than pulling a codec into the kernel; an unreadable slice leaves the facts and no picture. The ASCII ramp is always the floor.
- d133ef6: `image <path>` is a kernel command, not a surface verb. A new brasa builtin resolves what a path is — a DICOM series folder, a study, a `.dcm`, or a NIfTI/MGZ volume — and emits a typed `image.view` intent (schema and `IMAGE_MODEL_KINDS` in `@fnndsc/menu`) that every surface renders in its own way: ARGUS opens a rendered pane from the intent, a TTY prints the reflection the command renders (for a series, the same facts `dcm series` shows). So the same `image ~/uploads/sag-anon` works from a browser and from a terminal sharing one CALYPSO session. The surface keeps only the subverbs that drive a pane already on the field (`image layout|slice|wl|colormap|save|tags|load|guard|ghost`), declared shared so `image <path>`, `image --help`, and `image` alone fall through to the session; help lives in the kernel's registry. Opening an image no longer drifts into a surface-only verb.
- c70e11e: A landed series says where it was filed, and the image pane answers the press at once. A retrieve is confirmed by count and filed by CUBE a beat later, so the pull's "done" never knew the folder and a surface offering IMAGE on the row waited for the next query. The progress message now carries an optional `path`, `pull` resolves each landed series' folder before its channel closes and says it on the same channel, and the ARGUS PACS row takes the folder from the landing: IMAGE appears the moment the pull says the series is home. In the same breath, `image <path>` puts the pane on stage before the kernel is asked, with `OPENING <name>` on the field and on the bar, so a header read that takes seconds is never seconds of nothing; what could not open is named on the field, and counted loads say their percentage beside the count.

## 0.8.0

### Minor Changes

- 7c793ad: `pacs.query` series carry `folderPath`, the CUBE folder a pulled series landed in, so a surface can open the series as an image from the row that holds it.
- af2df66: New `dicom.series` and `dicom.tags` model kinds: a folder as a series, and a file's tags or a folder's constant-versus-varying split, with identifying tags flagged so a surface can redact by the flag.

## 0.7.0

### Minor Changes

- d89e31b: A feed-list row now carries `jobsErrored` (the errored-or-cancelled count, from the proc cache's per-status counters), so a surface can fill an errored feed's progress bar to the work that actually succeeded — `jobsDone - jobsErrored` over `jobsTotal` — rather than run it full in the error hue. The RUNS roster uses it; a full red bar said nothing a red mark would not.

## 0.6.0

### Minor Changes

- 49634f2: feat(menu): the telemetry heartbeat carries the lane (the running line, since when, how many wait) and CUBE's pace
- 2545ffa: feat(menu): the telemetry heartbeat carries the lab's pulse (`state`)

## 0.5.0

### Minor Changes

- 6cd5ab1: feat(menu): the `feed.indexing` envelope model — a feed asked for while its topology is still being indexed — and a `failed` field on the prompt context's feed-load progress
- 57ba039: feat(menu): the prompt context carries every feed topology walk in flight (`procWarmup.feeds`); `feed` stays the first for older readers
- 98ab832: feat(menu): the prompt context names the roster walk in flight (`procWarmup.roster`: delta or full)

## 0.4.0

### Minor Changes

- 116e8ba: feat(listing): progress is a trait of a row, and a row can carry verbs

  The operator's observation: progress is not a PACS quirk. A feed row should say how far its work has got without anyone opening it, and every level should report — a series its own pull, a study the sum of its series, a patient the sum of its studies.

  **The wire could not say it.** The `feed.list` model carried id, title, owner, status, created and two totals that need resident topology, so a roster genuinely could not know a feed's progress. CUBE's own job counters were already on the process cache, so the kernel now derives `jobsDone` and `jobsTotal` from them — settled meaning finished, errored or cancelled — and they travel with the feed row rather than waiting for topology. Kernel, wire, surface, in that order.

  **Progress aggregates by addition, not by average.** A study's progress is the sum of its series'. An average would let one finished series of a hundred files outweigh a stalled one of ten thousand.

  **A row with nothing scheduled still gets a track**, dimmed. The absence of a bar reads as "no such thing"; a dim track reads as "nothing has happened yet", which is the truth and the more useful statement.

  **Actions are not traits.** A trait says what a row is under some column; an action is a verb applied to it, and it sits outside the column grid because it answers to no cap. Capsules stop click propagation, so pressing one is not also activating the row.

  **Expansion has two modes**, declared rather than assumed: `replace` leaves the parent behind, `fold` keeps it on stage with the child inside. PACS exercises both in the next slice.

  The runs roster gains NODES and PROGRESS, which widened its positional track list from seven columns to nine.

  One smoke assertion changed, and deliberately: it counted seven cells per row as a literal. It now counts cells against the number of caps, which is the invariant that actually protects a positional grid and needs no edit when a column is added.

- 7181f7e: feat: a PACS question can be put to several servers at once

  `--pacsserver a,b` asks each named server and unions the answers into one listing. It is the same fan-out a cohort uses, discriminated by a different column: SERVER rides every study and every patient row, so two answers can be told apart, sorted and filtered.

  **A row names its server only when more than one could have answered.** On a single-server query the column would repeat one value down the page and tell an operator nothing.

  **There is no sweep-everything.** The CUBE this was designed against carries thirteen registered servers, several reading as one-off or per-person registrations; an `--all` would mean thousands of C-FINDs mostly into endpoints of unknown liveness. A fan-out is always something the operator named.

  **A server that could not be reached is `unasked`, not empty.** Verified live: naming a server that does not resolve leaves that row `—` with its reason while the server that did answer still reports what it found. A server that could not be reached has told us nothing about that patient; rendering it as a zero would say the opposite.

  The reason on such a row is stripped of the error stack's debugging prefix where it becomes model data, since it is read in a terminal table and on a graphical surface alike.

  Servers are keyed by their canonical identifier — what CUBE files a query under, and therefore what the replay index matches on, so a question already asked of one server replays while the same question to another is asked fresh.

- d2a4315: feat(menu): a PACS answer can say what it did NOT find

  `pacs.query` described what a query found and nothing else. That makes the answer an operator usually wants — which of these two hundred MRNs have no imaging — the invisible half of the result.

  The model now carries a patient level: every MRN asked, with its status, its study and series counts, the CUBE query that answered for it, and its own provenance.

  **Three states, not two.** `found`, `none` and `unasked`. A query that could not be asked is not a query that found nothing, and rendering a timeout as `0` is precisely the confident stale answer the replay work exists to refuse. An unrecognized status from a newer daemon degrades to `unasked`, the only degrade that never reads as an answer this contract never received.

  The studies keep their shape and stay on the model, each carrying its own `patientId`. The patient level is not a container for them — it is the record of what was _asked_, which is why it cannot be derived: a miss owns no study.

  Provenance is per patient as well as per answer, because a fan-out replays some rows and troubles the PACS for others.

  Optional, as `provenance` is: an envelope from a daemon that predates the fan-out still parses, and a surface reads its absence as the single-question case it could only have been.

- a245b5f: feat: choosing which PACS to ask is a strip you pick from, never a sweep

  SERVER became a column of the study listing, and the law that places a form's fields put its control there with no separate decision to make: the cell stands in SERVER's column, wearing the form's own label.

  It is a **state readout you press** — `PACSDCM`, `PACSDCM +2` — that unfolds a strip of segments beneath the form, one per registered server, lit when included; the field's touch or Esc retracts it, the same retraction grammar the mode frames already use. Not a dropdown: LCARS has no popup layer and should not grow one, since a floating menu is exactly the window chrome this grammar rejects — and a strip of the pane's own width carries thirteen servers where a grid track could not carry three.

  **There is no ALL, and there will not be one.** Thirteen registrations of unknown liveness would mean thousands of C-FINDs mostly into the void. A fan-out is always something the operator named.

  **One chosen is a context; several is a query.** One lowers to a visible `pacs connect`, so the session moves and the linked terminal's prompt follows. Several lowers to `--pacsserver a,b` in the editable line and moves nothing. The prompt changing, or not, is the honest tell.

  **The list comes from the kernel, not from CUBE.** `pacs list` now carries a `pacs.servers` model beside the text it always printed — id, identifier, and which one the session is on. A surface asking CUBE itself would be reading a different CUBE from the one its commands run against. Liveness is deliberately absent: CUBE registers servers, it does not test them, and a field that looked like health would be a claim nobody checked.

  Two things found live: the PACS pane's own commands had no way back to it — the DAG pane's already did — so `pacs list` answered into the void; and the document's retraction listener closed the strip with the very press that opened it.

  Law `a-server-is-named-never-swept`, smoke-enforced.

- 5a339f0: feat: a plugin is data — the manual becomes a projection of the model

  A plugin's substance existed only as text. `cat /bin/<entry>` fetched the plugin, formatted a manual, and that manual was the whole of what any surface could have — a paragraph nothing downstream can act on: not a card, not a parameter list, not a form, not an export.

  The kernel now builds the model first and renders the manual from it. `plugin info pl-dcm2niix-v2.0.0` answers with a `plugin.info` model carrying identity, the authoring facts, and every declared parameter; `cat /bin/pl-dcm2niix-v2.0.0` prints exactly the text it printed before, now as one projection of that model rather than a second independent scrape that can drift from it.

  **Parameters carry the flag as it is typed.** A plugin's own `flag` when it declares one, `--name` otherwise — a form built from the name alone would spell `--inputFile` where the plugin wants `-i`.

  **The parameter list is drained to exhaustion.** `getPluginParameters({ limit: 100 })` was one of the silent truncations catalogued in #401: a plugin declaring more lost the tail and said nothing about it. `pluginParameters_drain` walks to the end, and a live exemplar checks the model's count against the count CUBE itself reports — a client that both fetches and counts can agree with itself while being wrong.

  cumin gains `plugin_find` and `pluginParameters_drain` on the typed contract, so the `/bin` reader no longer reaches past it to the raw client.

  No surface change: this is the wire fact a plugin's one-node graph will read.

- 62761a3: feat(menu): a question says what kind of value it wants

  The wire has always carried a question — `prompt` / `promptAnswer` / `promptError` — and a surface has only ever been able to answer it with a line of text. That is enough for a terminal and not enough for anything else: argus refuses every prompt outright (`the argus surface cannot answer prompts`), so `sudo` dead-ends in the web surface and no control can ask for a value the operator has not already typed.

  A prompt now says what it is asking FOR, so a surface can choose its instrument rather than reading the wording and guessing:

  - **`wants`** — `text`, `secret`, `confirm` or `path`. Open-world: an unrecognized kind degrades to `text`, which every surface can answer, so a question from a newer daemon stays answerable rather than refused.
  - **`path`** — where browsing starts, whether a file or a directory is wanted, and a basename to offer. An errand that opens nowhere in particular is a browser, not an answer.
  - **`commit`** — the word the committing control should read (`EXPORT HERE`). A control reads as what it will do next.

  Everything is optional, so a daemon or a surface that predates this still parses and still answers. `hidden: true` with no kind reads as `secret` — what such a daemon could only have meant — and that reconciliation is `promptKind_of` in `menu` rather than a rule each surface re-derives: two readings of one message is how a terminal and a browser end up masking different things.

  No contract bump: the additions are optional, and `version_isCompatible` refuses on any mismatch, so a bump would turn a backward-compatible change into a hard break.

## 0.3.1

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

## 0.3.0

### Minor Changes

- 5dc064e: feat(boot): warm-up leaves the gate, and a failure that leaves it is still heard

  Boot blocked on four prefetches in front of the prompt. Measured against a live CUBE, `/PUBLIC` costs 8.4 seconds and `/SHARED` 9.3 — roughly eighteen seconds an operator spent watching a prompt that was already theirs, buying freshness the stale-serve path delivers a moment later anyway, since the checkpoint restore has already put those listings in the cache.

  Boot now blocks only on `/bin`, which completion cannot work without: an empty completer reads as a broken prompt rather than a fast one. Groups, Feeds, Public and a newly added `/SHARED` step warm behind the prompt under a new `PENDING` boot status. They keep their bounded retry policy; a transient failure should be retried before it is announced.

  `/SHARED` had no step at all before. That is where another identity's work becomes visible, and with nothing to fail, a CUBE that stopped serving shared paths stayed silent until somebody went looking.

  **A deferred step leaves the boot failure gate**, so its failure can no longer stop a daemon binding — and a boot readout has scrolled away by the time it arrives. The failure is held until a later attempt succeeds and carried on the prompt context, so every surface says it: chell's prompt reads `[warm-up failed: groups]`, and argus names it on the JOBS readout in mars with the reason on hover. Named rather than counted, because "Groups" tells an operator which capability is degraded where "1 warm-up failed" only tells them to go looking.

  Nothing reports a deferred completion. A warm that finishes and changes nothing is not news.

  Carries AEGIS law `deferred-warmup-failure-persists` with its smoke, which drives the surface's real prompt-context path rather than asserting a stub.

- 73aa61a: The feed roster (`proc feeds`, the RUNS pane) reports each resident feed's total output size and wall span, derived from the cache with no wire; `cd` into a CFS link now follows it to its target, and a refusal names that target.
- 4f034b9: Host control: `chell --daemon --host-control[=shell,files,pipes]` lets the daemon declare capabilities of its own — `!` runs on the daemon host, pipe segments run there, `upload`/`download` reach its disk — off by default, refused on a non-loopback bind without `--expose-host-control`, and annunciated everywhere (attach ack `hostControl`, the daemon face, the prompt's HOST segment, a remote shell's banner). Without the `files` tier, `upload` under a daemon now refuses instead of reading the daemon host's disk.
- aa25502: The process cache records the compute resource each plugin instance ran on (from the CUBE list row), and the `feed.dag` model carries it per node (`mixed` for a group whose members ran on different resources), so a surface can hue a graph by where its work ran.
- f8d1b1c: Index movement is annunciated: a feed's first-visit topology load (`feed 812 indexing: 3400/20000 17%`) and roster arrivals (`+feed 812`, feeds created since or newly shared) reach the prompt context's `procWarmup` segment — `feed`, `arrived`, and `sweeping` so a renderer can tell a sweep from a load — and the chell prompt renders both. The process cache keeps the two registers (`feedLoad_progress/clear/get`, `arrivals_note/recent`); the salsa feed walk and roster syncs feed them.

## 0.2.0

### Minor Changes

- 97af423: Watches: a surface can keep a running feed live. New wire pair `watch` / `unwatch` (subject = `/proc/jobs/feed_N`, owned per surface, released on detach) and a `watched` report (`live` | `settled` | `stale`). While anyone watches a feed the engine samples it on an adaptive cadence (3 s while it changes, backing off to 30 s when quiet), and whenever a visit changes the cache it publishes the refreshed `feed.dag` model to every surface as a session-bus envelope from the `daemon` surface, off the scrollback. A feed that settles reports `settled` and the watch ends; a failed sample reports `stale` and keeps trying. `proc watch <feed>` / `proc unwatch <feed>` are the console forms (`proc watch` lists). The engine gains an ambient event bus for events it originates on its own. Feed visits within one second of each other now share one sync, and `feedVisit_sync` reports whether it succeeded.
