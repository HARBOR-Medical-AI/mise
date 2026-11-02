# @fnndsc/argus

## 0.45.0

### Minor Changes

- f6790b6: Under stratus the first tile is OPENSHIFT, and `cluster` opens the controller. The tile counts CLUSTERS, and `domain` no longer opens anything.

### Patch Changes

- Updated dependencies [f6790b6]
  - @fnndsc/menu@0.32.0

## 0.44.0

### Minor Changes

- ac966ce: Markdown and AsciiDoc render as their page in the Viewer pane and behind RENDERED; opened source shows in colour.

  A file opened to read shows its source coloured; a Markdown or AsciiDoc document's header carries RENDERED (SOURCE returns). The editor colours AsciiDoc too. Rendering is sanitized and kept inside its pane: no script, links off the page open a new tab, images are named rather than fetched. The renderers load only at the first document.

## 0.43.0

### Minor Changes

- 605879e: Entering cloud management asks READ or MANAGE at the door, on the dashboard and in the console alike; the `--spend` flag is gone.

  Whether a stratus session may act on the tenancy (build, tear down, spend) is fixed when porter starts it, and it used to be asked for with `stratus oci --spend`: a flag no control on the surface could reach, and a word nobody would know to type. Now bare `stratus oci` asks on a sheet, the way trek asks its settings before the first turn: READ (look only; nothing outside this host changes) or MANAGE (act as well, each act after its own lock and the name typed back), with NOT NOW. `stratus oci read` and `stratus oci manage` answer in words. The ChRIS dashboard gains a CLOUD tile where the page came through a porter; it runs the same line, so the question is one question pressed or typed. `--spend` and `--read` are refused by name.

## 0.42.0

### Minor Changes

- 9a58e99: The TD controller and the dashboard say Trusted Domain, and show a found one as the cloud says it.

  DOMAINS is now TRUSTED DOMAINS on the tile, the controller's header, its stage, its log and its command labels. The tile counts the Trusted Domains that stand and, apart, those with nothing left of them (`1 GONE`); a found domain's row carries its condition.

  On the controller a found Trusted Domain shows its address, its spec and its steps as far as the cloud attests them, with ADOPT first on OVERVIEW. One with nothing left but its tag reads FOUND · NOTHING LEFT, says what is left (its compartment and what it holds, its stack), has no lock, and offers REMOVE WHAT IS LEFT on OVERVIEW and TEARDOWN. The TEARDOWN view lists what a teardown now also removes: the stack itself, and the domain's own compartment with its image bucket.

### Patch Changes

- Updated dependencies [4cda616]
  - bsd-trek@0.4.1

## 0.41.1

### Patch Changes

- 90c17b3: The stratus dashboard paints DOMAINS without waiting on `capacity`. A paint waits a moment, shows CAPACITY as READING, and paints again when the answer lands; one `capacity` is on its way at a time.

## 0.41.0

### Minor Changes

- 6323634: The CAPACITY tile opens a pane: what the region has free, one block per family, a row per limit and zone (#1284). `capacity pane [<family>]` types the same, and the TD controller's SIZE now asks for its sizing when NEW opens on it instead of waiting forever.

### Patch Changes

- 4568c64: The DOMAINS tile and the TD controller show every domain the tenancy holds, not only the session's folder (#1286). One not adopted reads FOUND · NOT ADOPTED, its OVERVIEW note carries ADOPT, and PLAN, VERIFY, BUILD and TEAR DOWN read REFUSED on it until it is adopted.
- 24c7433: The TD controller and trek's bridge are drawn in the ARGUS frame: the same gutter, elbows, bands and strips as the page. Each had drawn a frame of its own, a hundred pixels wider in the gutter, with its head and body elbows touching and its body opening on bare text; now one frame (`features/takeover/frame.ts`) serves every screen that takes over, built on argus.css's own rules so the two cannot drift again (#1285).
- Updated dependencies [4568c64]
  - @fnndsc/menu@0.31.1

## 0.40.0

### Minor Changes

- 0efbb7c: A PULL in ARGUS runs in the background: the console and every other press stay yours while a retrieve goes on. The press sends `pull … &`; the badges follow it as before, each running joblet is a row on the LANE instrument with a STOP that types `kill %N`, the console prints when one starts, ends or waits for an answer, and RESTART names the joblets it would end (#1273).

  A joblet relays its progress, and any model it answers with, to the surface it came from; its task carries its progress. The heartbeat's lane lists the running joblets, calypso answers `GET /joblets` (token-gated), and a porter login that finds a session on older code keeps it, rather than restart it, while joblets run.

### Patch Changes

- Updated dependencies [41769da]
- Updated dependencies [0efbb7c]
- Updated dependencies [b8bc519]
  - @fnndsc/menu@0.31.0

## 0.39.2

### Patch Changes

- f8b07e0: A backslash inside single quotes is now just a backslash, as in any POSIX shell (#1258). `grep '\.mgz$'`, `find … -name '*\.nii'` and `printf '%s\n' a` reach their command with the backslash they were written with; before, the line dropped it, so a pattern meant "any character" where it said a dot.

  Quoting follows POSIX throughout: inside single quotes every character is literal; inside double quotes a backslash escapes only `$`, `` ` ``, `"`, `\` and newline (`"a\"b"` and `"\$HOME"` work as before) and stays before anything else (`"a\b"` keeps it); outside quotes it escapes the next character. The word parser and the `;`, `|`, `>` and `$( … )` splitters read one rule (`lib/quoting.ts`), so none of them splits a line its words read otherwise. A line that relied on `\'` inside single quotes, such as `'it\'s'`, now closes the quote there; write `"it's"` or `'it'\''s'`.

  ARGUS quotes the lines it writes (an EDIT save, a cohort's `gather add`, a tag) the same way: single quotes, with a single quote written `'\''`. Its old quoting doubled every backslash and wrote `\'`, which under these rules doubled a backslash on every save and refused text with an apostrophe.

## 0.39.1

### Patch Changes

- 7b0cc57: The cohort band redraws when `gather process` or `pull --new-feed` changes the cohort, typed anywhere (#1252). Both commands changed the cohort (its feed, where its series landed) but answered only with their run or the feed they made, so a surface showing the cohort did not learn of it.

  Each line still answers with its own result, so `R=$(gather process …)` holds the run and `F=$(pull --new-feed …)` the feed, as before. The cohort goes out on the session bus as well, and ARGUS's ChRIS routes adopt a `gather.cohort` arriving there the way they adopt one a line answers with.

## 0.39.0

### Minor Changes

- f27596d: A domain's build now puts ChRIS on its cluster and checks it end to end, once the cluster has settled.

  The steps after the install are no longer placeholders. `verify` runs the ten checks and asks again each minute, for up to 30, while a new cluster's operators settle. `chris-deploy` installs the fnndsc/chris chart with `helm`, pinned to one node. `chris-seed` makes the test user and the smoke plugins through chrisomatic. `smoke` runs miniChRIS-OKD's journey against the public Route. BUILD and `tenant.mise` now build all the way through `smoke`, and the Kubernetes client waits out the 429 a settling API answers.

- fd1711f: A domain whose build stopped part way reads STOPPED, not SIZING · NOTHING BUILT.

  The new condition covers steps done with none running and the domain not up. The line under it reads PLANNED · NOTHING BILLED when the next step is the first that bills, as after NO at the billing question, and NOT FINISHED otherwise.

- 02c20bf: Every function name now says what it does: the 462 that put a preposition where the verb goes are renamed (#1227).

  The style guide names a function `<subject>[Qualifier]_<verb>[Adverb]`. Names such as `answerRows_of`, `seriesUID_ofPath`, `options_toParams` and `ask_onPane` put a preposition in the verb's place, which names the result without saying whether the function derives, parses, builds or renders it. They are now `answerRows_derive`, `seriesUID_parse`, `options_convertToParams` and `askOnPane_await`. A preposition may still qualify the verb (`x_readFromCache`) or the object (`askOnPane_await`); it may not start the method.

  `npm run lint:rpn` (`scripts/rpn-prepositions.mjs`) refuses a function, `const` function or underscored method whose method is, or starts with, `of`, `to`, `with`, `from`, `for`, `by`, `as`, `in`, `on` or `at`, and CI runs it. The exported names change with no aliases kept: nothing outside this repository imports them.

- 55e2041: A new domain finds its DNS zone in the tenancy: the only one by default, else one chosen on SIZE or named.

  `domain new` and `domain size` read the tenancy's DNS zones; a named `--base-domain` must be one of them, and with several and none named `domain new` refuses, listing them. The size model carries `dnsZones`. In ARGUS, SIZE shows a ZONE choice and COMMIT stays dark until a zone is set.

### Patch Changes

- 60c3017: Typing a domain's name opens the TD controller from the first paint, before the controller has read the domains.

  The DOMAINS tile's read now tells the language the domains' names, so a freshly opened stratus session claims `domain quay` at once.

- 68d496d: Pressing the DOMAINS tile now opens the TD controller, and an adopted domain shows the ChRIS steps it already did.

  Before, the tile opened the files listing, so the controller could only be reached by typing `domain`. An adopted domain read as unfinished because adoption carried only the machine's steps. Adopting a domain again catches it up from its checkout.

- Updated dependencies [fd1711f]
- Updated dependencies [4bc9d87]
- Updated dependencies [02c20bf]
- Updated dependencies [55e2041]
  - @fnndsc/menu@0.30.0

## 0.38.0

### Minor Changes

- e1d052d: ARGUS shows the kernel's cohort instead of keeping its own copy. Its GATHER, REMOVE, CLEAR, name and CREATE FEED presses send `gather add|remove|clear|name|feed`, and the band and the GATHER pane redraw from the `gather.cohort` model those verbs answer with, including a line typed at any chell on the session. ARGUS no longer writes `~/gather/current.json`.

  The kernel now fills in what the surface used to supply. `gather add` on a PACS path takes the series' description, modality, file count, patient and study from the query answer the path names (from the PACS mount's cache, so at most one CUBE read per query). A gathered folder is imagery when its name or place says it is a series, by the rule ARGUS's viewer uses, which now lives in `@fnndsc/menu` as `seriesFolder_is`. `gather feed [--title T]` makes the cohort's feed: series still at the PACS are pulled first, then one feed is rooted on every member, folders included. `gather name` answers with the cohort, and so does a `pull` that noted landed folders on it.

  `PacsVfsProvider.queryResult_fetch` is public, and `vfsDispatcher.pacs` names the PACS mount. `pacsQueryModel_build` moved to `builtins/net/query.model.ts` and is still exported from `query.ts`.

- 682f713: One login reaches your cloud too: `stratus oci` switches a ChRIS session to your stratus one, and `chris` comes back. The porter starts or rejoins it on the OCI key filed under the person's ChRIS identity (`porter --creds <user> --oci <config>`, run on the host), in a home and state of its own, read-only unless `stratus oci --spend` is asked for with `spend` typed; it restarts on the same tier and is adopted after a porter restart. No one reaches another's tenancy through the door (stratus.adoc D14).
- a26fbd4: In a stratus session the TD controller takes the screen: every control sends a line, and the engine asks on its strip. `domain` opens it. A pill per domain and NEW; CONDITION, cost, build and what changed since the last command in the header; OVERVIEW, SIZE, BUILD, CLUSTER, CHRIS and TEARDOWN as views; the billing question answered by YES · BILL or NO, teardown's by the name typed back; SIZE's levers redrawing fit and cost from `domain size`, COMMIT sending `domain new`. A DOMAINS row opens it on that domain. Under 1250 px the line runs as text.
- dd0b518: A tenant is a manifest: `~/tenant.mise` builds a domain from its written spec through the install and verifies it.

  stratus ships `tenant.mise` and shows it in the session's home beside the domains; `play ~/tenant.mise --param NAME=quay` runs `domain build --through run`, `domain verify` and their claims, answering the domain's status. The session's files can now be read by `play` and a surface. In ARGUS, the TD controller's COMMIT writes the spec and then plays the tenant on BUILD.

### Patch Changes

- Updated dependencies [e1d052d]
- Updated dependencies [05ec948]
- Updated dependencies [46bc80d]
  - @fnndsc/menu@0.29.0

## 0.37.1

### Patch Changes

- 0a52833: A pipeline run answers every node it made, and a run's model says how it settled. `pipeline.scheduled` carries each node's instance, plugin, output folder and status, with the leaves nothing runs off, so `${P.instances.outputPath}` reaches every node and bare `${P}` is the nodes' ids; before, a pipeline passed as one plugin's run with the first id and an empty output path. `run.scheduled` gains `status`, CUBE's word as the run settled or `detached`. ARGUS lights a pipeline's feed as it lights a plugin's (#1208).

## 0.37.0

### Minor Changes

- 49ccdfd: The console's prompt bar draws a backend's segments, and a session over stratus wears the Trusted Domain's brand.

  The brand: the North Star in the driver's ring in the header and the tab, the mark as the splash, and the credit line "a Trusted Domain console".

  The prompt bar is drawn from the daemon's segments in the daemon's order when it sends them, a glyph by key and a colour by tone, with a long identity cut from the left and whole on hover; a ChRIS daemon's bar is unchanged. What the stratus composition owns in the page's markup carries `data-composition="stratus"` and stands only under it (docs/stratus.adoc, D11; tiles and panes follow in later slices).

- dcdc6cd: A stratus dashboard shows DOMAINS (each domain's last build step) and CAPACITY (what each zone has free).

  DOMAINS reads `domain status` and CAPACITY reads the new `capacity` command, through the wire's new `stratus.domains` and `stratus.capacity` models (menu). `capacity [<family>…]` lists, for the shape families named or those the domains' specs name, each limit their shapes draw on per zone, permitted and free; a shape now names its limit service. A domain with a step gone wrong shows in red.

### Patch Changes

- 9b0aabe: The DOMAINS tile's explanation says a domain holds its spec, state and steps. These are the words the operator approved.
- 7c65644: A stratus or null session opens with the header and console on stage around the dashboard, not zoomed alone.

  A frame-alone daemon serves on a fresh port each start, so every boot was a first visit and hid the identity and the prompt behind the landing zoom. The DASHBOARD gutter still zooms the dashboard; a ChRIS session is unchanged.

- 49501d4: The HOST lamp's title says what each tier hands the daemon. A tasks-only daemon is no longer said to run `!`.
- 14f8fc1: The DOMAINS tile now shows what each domain costs an hour, and the total across them, when the daemon priced them.
- Updated dependencies [49ccdfd]
- Updated dependencies [49501d4]
- Updated dependencies [14f8fc1]
- Updated dependencies [dcdc6cd]
  - @fnndsc/menu@0.28.0

## 0.36.2

### Patch Changes

- 4838250: The trek bridge scrolls an open question's control into view, and phasers stand barred under raised shields.

  On a short window the station column held a question's lit control below the fold, unseen: a torpedo's burst angles waited where nothing showed. The bridge now scrolls the lit control into view as the question opens. The PHASERS pill stands hollow while shields are up and its title says why, since the engine refuses to fire through them. The stacked-slider rule from the last release no longer misplaces pill-row labels.

## 0.36.1

### Patch Changes

- 7b8f772: The trek bridge's stars breathe in place in every browser, and a narrow window keeps the header's values whole.

  A `<use>` placed by x,y cannot be scaled in place (every browser scales it about the drawing's corner), so the stars slid toward the scan's corner as they breathed; every mark is now a group that carries its place, the symbol drawn about its origin. The header's three groups share the width with what moved since the last command under the mission; the left column holds the long-range scan and the chart sized to what is left, engineering in its own view; a slider's ticks thin out as the track narrows; the ship's own lines in the log carry the prompt they answered and are set apart from the engine's.

## 0.36.0

### Minor Changes

- 49f23f3: The trek bridge draws marks in place of the C's letters, and scans long range on arrival as a standing order. The short-range scan is one picture: each sector a pressable cell carrying a symbol for what it holds (a ship, a Klingon, a starbase, an inhabited system, a star, a black hole), the ship's mark turning to the course last committed and wearing a shield ring whose width and colour are the shield over its maximum (thin and dashed when down, the starbase's when docked), each Klingon wearing one of four marks that the engine's own lines carry from sector to sector, and facing the ship. The same symbols sit on the course wheels' rims, lead the target pills and fill a legend beside the C's glyphs, so one mark means one thing everywhere; the stars breathe slowly, out of step, which is the one motion with no engine line behind it and stops under reduced motion. The charts leave an unscanned quadrant empty, mark a supernova with the radiation trefoil, and the long-range scan shows the edge of the galaxy as such. The bridge now sends the engine's own `l` at the first `Command:` prompt and whenever the ship arrives in a new quadrant, while the long-range sensors work, and folds the scan's lines in the ship's log under one dim head. The arrow keys walk the scan; Enter presses a sector; the engine's bell is no longer a glyph in the log.
- 2ea9a84: The trek bridge moves: each frame replays an engine line or a state change, and the log scrolls with the picture. Frames play in the lines' order. A torpedo is an orange-red photon with a white heart and flickering pulses that flies the track the engine printed, point by point, trailing a comet tail; a Klingon flies the sectors its `moves to` line names on a red track, or off the edge when it escapes, and the long-range cell it fled to blooms; a kill, a nova, a misfire and a supernova burst at their sectors after the node flare; a phaser beam joins the ship to the Klingon the hit line names, a Klingon's shot reaches the ship and flares the shield ring, which loses the absorbed share the line reports (and no beam is drawn when the line names no sector); a move lays a dashed track from where the ship was to where the state puts it, a pulse runs it and the ship slides with it, and a crossing runs the ship off the edge, dims and rescans the grid, blooms the long-range cell that becomes HERE and runs it in from the matching edge. A command pill, a view or Esc jumps the picture to its end, and reduced motion always does. Four cues join the bridge's voice, `nova`, `supernova`, `klingon-pass` and `shield`, for now played with the nearest models in the bank until their own are chosen.

### Patch Changes

- 4e14d8e: Internal: the moving trek bridge is proven, under two new laws: one mark everywhere, and a frame replays a printed line. A scenario on seed 13 counts the frames the picture played against the log's lines kind by kind, checks the torpedo's frames are the printed points and the kill's burst follows its line, reads the same Klingon mark on the scan, the wheel and the target pill, sees the long-range scan filled by the standing order at the first prompt, and presses a view pill during a quadrant crossing to find the ship landed at once with the log whole; a lint keeps every mark drawn from the one symbol table.

## 0.35.0

### Minor Changes

- 747193f: The trek bridge opens from the ARGUS command line in either console: prefix-`:` or the LANG capsule, then `trek`.

  Under the terminal console `trek` typed at the prompt is the pty's and plays as text; the command line is the way to the bridge there. The surface claims only a game: `trek --credits`, `--help` and `--version` answer in the session as before.

## 0.34.0

### Minor Changes

- 5cdc0c8: ARGUS has a voice: every sound synthesized in the browser from a spectral model, and the trek bridge heard by rule.

  A cue is a compact spectral resynthesis of a reference clip (partial tracks and noise bands), played through Web Audio; no recording ships. The bank names a cue for each of the game's events and one computer beep for each of the bridge's pills: a pill that only opens, sets or answers beeps, a pill that does something is heard as the thing, and the alerts, hits, kills and docking are heard from what the engine shows and says. The frame's own four beeps go through the same voice; a deployment that keeps recordings of its own still hears them, because the porter now names its sounds folder's files at `sounds/index.json`. The audio pill is the one mute. The analysis tooling that makes a model from a clip is in `tools/trek-sound`.

### Patch Changes

- 779ccf9: Internal: the trek bridge is proven by a smoke scenario and four AEGIS laws that name what it must keep.

  `trek-bridge` runs on the transcript lane: the page hides behind the bridge, the setup is answered by pills, a move goes through the engine with a pressed sector a tenth of a quadrant, the station views draw, the computer answers through the engine, the voice's bank plays, and Esc asks before LEAVE ends the game with the console back at READY. The laws: a program may take the screen, a program gives the screen back (a lint), a bridge answers the prompt in front of it, a pill that acts is heard as the thing.

## 0.33.0

### Minor Changes

- f42918a: trek takes the screen in ARGUS: a bridge drawn from the state the engine shows, played through its controls.

  `trek` typed at the transcript console opens the bridge over ARGUS and runs the session's `trek` as the operator's own command. The bridge reads the state the engine shows before each `Command:` prompt (a header of condition, ship, mission and position, the short- and long-range scans, the galaxy chart as the ship knows it, engineering) and answers the engine's questions one at a time from controls lit by the question: command pills, a course wheel, sliders for distance, warp factor, rest and phaser units, pills for choices, and a strip for the questions the engine asks on its own. The ship's log is the game's own words, read only. LEAVE BRIDGE (and Esc, which asks first) abandons the open question; the engine reads end of input and ends the game as the C does, and ARGUS comes back. bsd-trek gains `bsd-trek/host` (the state's types and the C's tables and codes, with no engine behind them, for a host that draws the game), its styling wrapper passes `state_show` through, and end of input is asked for once. The session's `trek` reads an abandoned question as end of input.

- 171bbe4: The trek bridge gains its station views: HELM, TACTICAL, ENGINEERING and COMPUTER, drawn from the engine's state.

  HELM and TACTICAL enlarge their stations beside the short-range scan; ENGINEERING is the damage control report whole, with repair times in flight and docked, the ship's reserves as gauges and a rest preview; COMPUTER is the galaxy chart large with the computer's requests as pills and its arithmetic (course and distance, warp and impulse cost, phaser effect, the score) worked live beside the engine's own answer. Manual phasers play bank by bank at TACTICAL. A station names its step and offers CANCEL where the C has a "never mind". The score stands in the header. A pressed sector's distance is sent in quadrants, as the C reads it (the bridge sent sectors before), and the frame's two elbows are joined.

### Patch Changes

- 21649d1: A running command can show its surface a typed event, and trek shows its state at every Command: prompt.

  `OutputSink` gains `event_write(kind, data)`, the wire gains the `event` message (daemon to the command's origin surface, live only), and the ARGUS client hands events to its host. bsd-trek's `TrekTerminal` gains `state_show`, called with a deep copy of the whole game state before each command is asked for; the session's `trek` sends it as `games.trek.state`. The recorded C games replay unchanged; a terminal that only prints leaves `state_show` out. This is what a bridge that draws the game reads, instead of the printed scans.

- Updated dependencies [f42918a]
- Updated dependencies [21649d1]
  - bsd-trek@0.4.0
  - @fnndsc/menu@0.27.0

## 0.32.0

### Minor Changes

- fb6813d: Any running command can now be stopped, with Ctrl-C or the console's new STOP capsule. A host process it started is killed, and a command that does not end when asked is abandoned after three seconds so the session is free again. A chell that disconnects stops its command, and Ctrl-C reaches a host program in the terminal.

### Patch Changes

- c1ad144: Full-screen host programs such as vi, top or your own zsh now work in the ARGUS terminal when host control is on. `!cmd` typed there runs in the terminal's own pty, and Ctrl-C reaches it as an interrupt.
- 5dadfdd: The terminal console's text is the old console's size again, and a new clear command empties the console. The terminal had taken the page's larger size because xterm measured it before the console's styles applied. clear empties the screen and scrollback in a terminal and the record in the transcript; Ctrl-L still clears the screen alone.
- Updated dependencies [fb6813d]
  - @fnndsc/menu@0.26.0

## 0.31.0

### Minor Changes

- 66f1956: sl, cmatrix, rain, asciiquarium, tetris and snake play in the terminal they are typed in; --pane draws them in ARGUS's GAMES pane. The programs move to `@fnndsc/menu/games` so chell and ARGUS run the same ones; chell takes the screen (alternate screen, raw keys, the console's hues) and gives it back on q, Esc or Ctrl-C, and marks the console `playing` meanwhile. The transcript console, with no screen to play on, keeps the pane.

### Patch Changes

- Updated dependencies [66f1956]
  - @fnndsc/menu@0.25.0

## 0.30.1

### Patch Changes

- d26f22c: Listing /proc/jobs and entering a feed no longer wait on CUBE: the roster check runs behind the answer after 250 ms. A session booted from a door's token keeps its folder lookups memoised, as a password boot always did; a lookup that finds no folder (a shared feed's own path) is kept 15 seconds instead of asked again by every caller; `ls` reads a listing once; a parent's fresh listing answers whether a child is a folder; the PACS server list is kept a minute. The terminal console's text is the transcript's size again.

## 0.30.0

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

## 0.29.0

### Minor Changes

- 1a2a0d0: An open question shows across the session: `? N WAITING` on the ARGUS status strip, and `? N waiting` in chell's prompt. The daemon counts the questions open on every surface: they ride the heartbeat's lane (which surface asked what, and for how long) and every prompt context. ARGUS names each one in the strip's title and adds an ASKING row to the lane instrument; `who` says what each surface is waiting on. A question no longer freezes the session, so this is how a game paused in another tab, or a confirm left in a terminal, is not forgotten (#1128).

### Patch Changes

- 7fefdbe: The console now uses JetBrainsMono Nerd Font Mono: the prompt's segments and icons sit on the same grid as the text. Share Tech Mono had none of those glyphs and borrowed them from MesloLGS NF at another width; the new face holds every glyph the prompt, the listings and the scans use at one cell (measured), with MesloLGS NF kept behind it for the rest. It is bundled as WOFF2 with its OFL licence. This readies the console for the terminal it becomes (#1125).
- Updated dependencies [c73c81b]
- Updated dependencies [1a2a0d0]
  - @fnndsc/menu@0.23.0

## 0.28.6

### Patch Changes

- 216760d: SHARE VIEW gives you the lines that put a colleague exactly where you are. The new header pill (and `desktop share` in the console) shows your current view as a short script starting from `desktop clear` (which keeps your own screen as a PANES card, then goes to the dashboard), and copies it. Pasted or typed into the ARGUS console, the script rebuilds the same panes, graph settings and selected job.
- 6aa7bc6: A view can be sent as a link or a file, and opening one is safe. SHARE VIEW's COPY LINK gives a link that opens ARGUS on the same view, and `desktop load <file>` opens one kept in ChRIS. A received view shows its lines and asks before running, runs only view commands (never `rm` or anything else in your session), changes your graph settings for that visit only, and says where it stopped if it cannot finish. FILES panes now record their folder too (`file open <folder>`).
- d5a3b1c: Everything the RUNS graph shows can now be set from the console, and a desktop records all of it. New: `dag pulse|census|gravity on|off`, `dag draw spheres|stars`, `dag select <feed or job>` (the JUMP TO fly-to) and `dag enter <job>` (then ENTER NODE). `desktop show` now writes every graph setting and the feed or job on stage, so the script replays the same view anywhere.

## 0.28.5

### Patch Changes

- 2086f4e: A download's row never freezes, and a cancelled download stays cancelled. Every question the row asks the session has a 5 s deadline: a session that stops answering reads LOST TOUCH WITH THE SESSION, and a cancel with no answer says so and can be pressed again. A cancel made while CUBE was still answering no longer lets the download start anyway.

## 0.28.4

### Patch Changes

- 3c8d56a: A download shows how far it has got, from the press to the end. A transfer row stands at the foot of the screen at once: waiting for CUBE, then bytes of the whole with the rate and the time left, then done, failed with CUBE's reason, or cancelled, with CANCEL to stop it. The daemon counts the bytes it passes (`/vfs?progress=<id>`, `cancel=<id>`) and holds the probe's stream for the browser's save, so CUBE is asked once instead of twice.
- 5102036: A place's link is always in sight, and copying it says so. FILES shows the link under every path trail and RUNS shows it in the graph's corner (the selected node, else the feed), in full behind a LINK pill. A press copies it and the pill reads COPIED, or SELECT + COPY with the address selected where the browser has no clipboard. A row's LINK points that line at the row. The LINK pill on the RUNS rail is gone.
- 36cf130: A FILES pane that cannot list its place says so instead of standing blank. A pane opened on a folder (by a link, a walk or BACK) whose listing fails now reads COULD NOT LIST with the session's reason, on its bar and in its field, and the console notes it.

## 0.28.3

### Patch Changes

- 11a9212: A census is drawn as smoothly as a shape, and blooms with the wave. Census members took an 80-face icosahedron, faceted on a 4K screen; the cut now scales with how many are drawn (980 faces up to 2,000, 320 up to 20,000, 80 past that). Each census stage blooms as the wave lands on it, as a lone node's lamp does (none past 400 stages). PULSE stands on by default; a feed view kept before reads the new default for pulse alone.

## 0.28.2

### Patch Changes

- 91c93c0: A listing's columns give way when the pane is too narrow, instead of running under the frame's edge (#1067). The lowest-ranked columns stand aside until the rest fit, the bar says how many, and a wider pane brings them back. In RUNS, NODES goes first, then TIME, SIZE, OWNER and PROGRESS; ID, TITLE, STATUS and CREATED always stay. FILES and PACS do the same. The black square no longer covers the last column.
- 9065319: A feed shared with you is marked NEW until you open it, across logins (#1065). RUNS leads with a NEW SINCE YOUR LAST VISIT block, each row marked with who shared it, and the bar counts them. Opening a feed takes its mark off, and CLEAR NEW takes them all. `proc feeds --new` lists them and `proc seen` clears them. Your own feeds and public feeds are never marked.
- Updated dependencies [9065319]
  - @fnndsc/menu@0.22.2

## 0.28.1

### Patch Changes

- e29bf91: A feed shared to you is seen on your next look at the roster, not after the next ten-minute walk (#1058). The roster's delta reads each collection's newest page and walks whole when the total moved, so a share, an unshare or a deletion lands on the visit that follows it. `proc feeds <q>` matches a feed's title, its `feed_N` name and its id; a bare id the roster lacks is asked of CUBE live and adopted, or refused with why (not shared with you, or shared to a group you are not in). `ls /proc/jobs/feed_N` asks the same way. In ARGUS a RUNS filter that names a feed by id and matches nothing asks the session too: the row arrives marked, or the field says what CUBE answered. The roster frame gains REFRESH (`proc feeds --fresh`), and the bar says `CHECKING CUBE FOR THE FEED LIST…` while any walk runs and `FEED LIST CURRENT · n NEW` when it lands.
- a0f0160: Jump to a feed or a node by its number (#1061). `proc jump 639204` goes to the node, `proc jump feed_4389` to the feed, asking CUBE for anything shared since the roster was walked. A bare number that is both a feed and a node is never guessed: chell names both, and RUNS asks which. RUNS gains JUMP TO on the roster frame: it asks for the number, enters the feed, and selects the node once the graph is drawn, without moving the console's working directory.
- b95fedf: A link opens ARGUS where it points (#1061). `url [path]` in chell prints the door's address with the path as its fragment, LINK on a RUNS graph copies one for the selected node or the feed, and LINK on a FILES row for that folder or file. Opening the link lands there once: a feed or node in RUNS, anything else in FILES, without moving the session's working directory. The door comes from `CHELL_DOOR`; without it `url` prints the fragment and says so.
- Updated dependencies [a0f0160]
  - @fnndsc/menu@0.22.1

## 0.28.0

### Minor Changes

- 639b840: ARGUS over a backend other than ChRIS shows the frame alone: files, the console and its own tiles (#985). Before it builds, ARGUS asks the daemon `GET /backend` (token-gated; porter adds the token behind a door) and installs the ChRIS composition only for ChRIS; an older daemon is ChRIS. What ChRIS owns in the page's markup carries `data-composition`, and a saved ChRIS preset falls back to home. The FILES tile's description is the composition's (ChRIS keeps its own words). The smoke stage `frame-alone` checks both sides.

### Patch Changes

- be5f8b3: Nothing changes on screen: the DICOM image and tags panes are built by the ChRIS composition (#985). The panes and the verbs that open them move to `compositions/chris/dicom.ts`, bound to the surface by `chrisDicom_make`.
- 3060fa1: Nothing changes in the console: the ARGUS language takes ChRIS's words from its composition (#985). `language_extend` adds a composition's subjects, the views, claims and listings it adds to frame verbs, its chords and its verb lines; `compositions/chris/lang.ts` holds runs, dag, node, universe, PACS's listing, image and tags.
- 5afa298: Nothing changes on screen: RUNS and the universe are built by the ChRIS composition, not the frame (#985). Their builders move to `compositions/chris/panes.ts`, made from a context the frame hands in. The frame's DOM helpers move to `frame/dom.ts`.
- cd68355: Nothing changes on screen: the ChRIS composition hears its own share of the session's signals (#985). They move to `compositions/chris/signals.ts`; the frame keeps the prompt, the status bar, the lane, the restart control and the cascade.
- 322606e: Nothing changes on screen: what ChRIS puts on the stage is the composition's to declare (#985). `compositions/chris/stage.ts` names RUNS, the universe and PACS as primaries, their presets, and the panes ChRIS splits in; the frame adopts, mounts and registers what it names, and primaries are registered rather than fixed.
- a0b567f: Nothing changes on screen: the dashboard's ANALYSES, PACS and UNIVERSE tiles are the ChRIS composition's (#985). They move to `compositions/chris/tiles.ts`; the frame keeps its own tiles and places a composition's among them, its lead taking the wide seat when it has more to say than home.
- 6268376: Nothing changes on screen: every route from a result to its pane is one table the session's composition fills (#985). `frame/modelRouter.ts` holds the routes per channel, the claims an empty pane answers, and the watch listeners. The ChRIS composition installs RUNS, the universe, PACS, and DICOM images and tags (`compositions/chris/routes.ts`); the frame routes only listings and its own panes.
- 183aa7d: Nothing changes on screen: the daemon's attach answer names the session's backend, and ARGUS reads it (#985). menu's `attached` message gains an optional `backend`; calypso fills it from the backend it hosts (`chris`, `null`). ARGUS's `attachBackend_get` reads it, and an older daemon without the field is ChRIS, so a new ARGUS against an old calypso draws what it always drew.
- 3175b3d: Writing into a missing folder says `No such file or directory`, as on a disk, rather than making the folders. `touch` and `mv` go through the backend's filesystem (#1001). touch writes with the mount's `write`. A file already there is kept as it is when no content is given, and a projected file takes text only. ARGUS makes `~/gather` before it writes the cohort there, and waits for it. mv moves into a folder the destination names, keeping the source's name. It says a missing source by name and passes the mount's refusal on once (CUBE cannot overwrite). The shared helpers (`entry_at`, `folderTree_make`) live in `builtins/fs/entries.ts`. The native mount drains what looking up a missing parent said, as `pathHolders_find` does.
- 012b966: Ctrl-B ; after a split returns to the pane you split from (#1049). The layout gave a split's new pane (and a moved pane) focus without recording the pane that had it, so tmux's last-pane key had nothing to go back to and Space then flipped the wrong pair.
- 0d3cf0b: A session over a backend other than ChRIS no longer wears ChRIS's brand (#985). The header logo, the credit line's ChRIS clause, the brain splash, the favicon and the ChRIS packages in the version stack are the composition's; any other backend gets an empty splash, one console line naming the backend and a neutral favicon. A ChRIS session is unchanged.
- Updated dependencies [183aa7d]
- Updated dependencies [27f3021]
- Updated dependencies [6752575]
  - @fnndsc/menu@0.22.0

## 0.27.2

### Patch Changes

- Updated dependencies [8d15909]
  - @fnndsc/menu@0.21.0

## 0.27.1

### Patch Changes

- Updated dependencies [5bb17f6]
  - @fnndsc/menu@0.20.0

## 0.27.0

### Minor Changes

- 77e3eba: The keyboard now reaches every pane's frame and every listing's rows: PACS search to series needs no mouse. Over a listing, ↑↓ move a row cursor, Enter indicates a row and Enter again opens it; → or Ctrl-B r takes the keys into the frame, where ↑↓ or Tab walk the verbs and ← leaves. Esc in a pane's text field hands the keys back, a prefix focus move takes them out of the console, and Ctrl-B & (or `pane close all`) closes every pane.

## 0.26.7

### Patch Changes

- f9244ad: The universe's star threads now carry the pulse wave in SHAPE mode too, not only in CENSUS. A finished run's threads replay stage by stage and a live stage's stream; faint scenery rests, and a thread a replay or hand-off has hidden carries no wave. `universe state` also reports the median edge length and the longest edge with the two stages it joins.

## 0.26.6

### Patch Changes

- bd0af06: A census's connecting lines now carry the pulse wave, so information travels down every connection in a big feed. Past 20,000 connections a census draws lines instead of tubes, and under STARS it always draws threads; both used to sit still and now stream into a live stage and replay a finished run exactly as tubes do.

## 0.26.5

### Patch Changes

- dc75d9b: CENSUS on a feed shells every job again, in RUNS and inside a universe descent, instead of looking like SHAPE. A feed view's nodes are tubed but no longer marked solid, so orrery's census no longer holds them out; the canvas now says how many jobs the census holds (`data-census`).

## 0.26.4

### Patch Changes

- c5e033d: A feed now looks the same from the RUNS roster and from the universe. Either way it is one tree, root on top, every node lit with its tube. Both doors read the feed with one builder, and the universe's descent lays the feed out as that tree and holds it there instead of settling it into a free-form burst. An orrery unfold can now take positions the surface laid out itself (`placed`), held where they are put.
- 71fe8a5: A feed has one frame and one memory, whichever door opens it. RUNS and the universe's descent carry the same verbs (arrangement, 3D, SPHERES/STARS, pulse, metric, hue, census, gravity, and the feed's note, tags and name), and the modes this device last chose stand in both, so a feed switched to MOLECULE in the universe opens as MOLECULE in RUNS. Inside a feed the universe shows the feed's verbs and steps the space-only ones aside; its own draw style comes back on the way out. STARS now works inside a feed: nodes become points of light on fine threads, where before every feed node stayed a sphere. An orrery node can be `tubed` without being solid.
- 10f843b: A feed entered from the universe is now live, as it is in RUNS. The universe holds the session's watch on the feed it is inside: fresh statuses patch the drawing in place, a feed that grew is redrawn where it stands, and the readout says INSIDE · LIVE, SETTLED or STALE. Both doors use one same-shape test and one patch.
- 820b8f1: A node picked in a feed shows the same facts from either door. RUNS and the universe now share one overlay: plugin, instance, status, a group's count and faults, wall time, size, the line of stages, and ENTER NODE and PROCESS, with PROCESS refused on a ×N group as RUNS always did. RUNS no longer draws its own copy of the universe behind a refused roster or when the universe is asked for; the universe pane is where the space lives.

## 0.26.3

### Patch Changes

- f504a1b: Dragging a column boundary in a listing now moves that boundary with the pointer, the way a file manager does. The two columns beside it trade the width, within their minimums. Before, a grip widened the column to its left and let NAME absorb the difference, so on a files listing every column grew away from the hand and the NAME | TYPE boundary did nothing. A double-press gives both columns back, and a boundary never moves against the hand. On a row already wider than its pane, as on a tablet, the column you drag simply grows and the row grows with it.

## 0.26.2

### Patch Changes

- 85b3f31: The console says when it is busy. Its element wears `data-busy` from the moment a line is submitted until that line's prompt returns, so a line typed meanwhile is known to be queued rather than lost. Nothing on the surface declared this before, and a scenario that typed on a fixed clock asked a pane question in a directory its `cd` had not reached yet.

## 0.26.1

### Patch Changes

- 9742de9: The dashboard's CONSOLE block shares its row with KEYS and WHAT'S NEW. every block says what it is in a line or two, and a column's grip is wider and shows a hairline whenever the hand is on the cap, so it is found before it is felt.

## 0.26.0

### Minor Changes

- c806e86: Columns in every listing can be sized by hand. Drag the edge of a column cap to size it, double-press the edge to give that column back, or press COLUMNS on the frame to give them all back; the sizes are remembered on this device, and the progress column is never sized by hand — it takes what the others give.

## 0.25.1

### Patch Changes

- 4e789d9: A narrow runs roster shortens the title before it lets the progress bar vanish. The title track gives from 24em down to 12em (with an ellipsis) and the progress track keeps at least 8em; on a wide pane nothing moves.

## 0.25.0

### Minor Changes

- 5a0eef5: A WHAT'S NEW block on the dashboard says what the installed release changed, and opens the notes as a pane. The NOTES pane lists one block per release and a row per change, the rest unfolding on a press, with LATEST/LAST 5/ALL and INTERNAL pills; when the daemon is out of date, the notice says in one line what the newer release brings.

### Patch Changes

- Updated dependencies [5a0eef5]
  - @fnndsc/menu@0.19.0

## 0.24.1

### Patch Changes

- 5b64328: `sl` on the GAMES pane flies the Enterprise — the Constitution-class refit side view from the Star Trek ASCII Art blog, credited in the source — left to right, a warp wake behind the nacelle.

## 0.24.0

### Minor Changes

- 6901a81: The games shelf (#892) on the stage: a GAMES block in the KEYS pane naming `help games`; `say` speaks and a chime is noted and spoken; and a GAMES pane — a canvas of glyphs in the theme's hues, its cell sized to the field — runs the showpieces and the arcade the kernel answers with (`sl`, `cmatrix`, `rain`, `asciiquarium`, `tetris`, `snake`): the field takes the keyboard when a game starts and Esc gives it back, PAUSE and RESTART ride the frame, a second program reuses the pane on stage.

## 0.23.4

### Patch Changes

- c198398: The dashboard shows one ▼ MORE chip, not two stacked: its body speaks only in the phone layout where it is the field that scrolls.
- 316ad34: Zooming the console (or any pane) after leaving the dashboard takes the whole page again: the header's height was measured mid-glide and the zoom slid it only a few pixels. And FILES-02 brings the files back after KEYS was opened from the dashboard (it used to think it was already home and fold the gutter away).

## 0.23.3

### Patch Changes

- 02dd705: A press on a dashboard block opens only what it names: the gutter comes back with the pane, the header stays folded away and the console stays closed (the CONSOLE block, CONSOLE-05 or the header strip bring them). Esc on the dashboard still gives the whole surface.

## 0.23.2

### Patch Changes

- 73c0087: A PACS series that arrives is no longer shown as ERROR. The retrieve watch always asks CUBE before it gives up on a series (with no retries, the default, it never did), a series not seen to finish and not yet in CUBE is UNCONFIRMED with its reason rather than ERROR, and the watch waits a minute (not fifteen seconds) for a PACS slow to begin. Progress messages carry an optional `reason`, shown on the ARGUS badge and in pull's summary. In ARGUS a fresh answer finding a series home in CUBE replaces a pull that ended badly, and a pull waiting on its first file paces again instead of drawing a still empty bar. After twenty seconds of silence a pull checks CUBE and then asks whether to keep waiting (a surface that cannot be asked waits a minute). ARGUS runs the PACS pane's pull and query as the operator's own acts rather than instrument traffic, so they can ask.
- Updated dependencies [73c0087]
  - @fnndsc/menu@0.18.0

## 0.23.1

### Patch Changes

- 9888eff: The console answers a double click on its header as every pane does (zoom, and again to restore), and the lid closes the console even while it is zoomed (it did nothing there, and so did CLOSE in the console's drawer).

## 0.23.0

### Minor Changes

- c9f9156: A session begins at the dashboard alone on the screen: no header, no gutter, no console, just the blocks, each now saying in plain words what it is for. Any press opens what it names and gives the full surface back (so does Esc). HELP is KEYS, and from the dashboard it opens alone instead of beside a file listing; CONSOLE is a block of its own. On a phone every block shows all it says.

### Patch Changes

- d04a2ef: A double click (or double tap) on a pane's header zooms the pane, and another restores it, as a title bar does on every desktop. ZOOM in the pane's drawer stays the visible way; KEYS lists the double click beside the `z` chord.

## 0.22.3

### Patch Changes

- baec61d: The UNIVERSE's 3D / 2D block acts on what is in view. Inside a feed it used to flatten the whole galaxy behind the one feed being read; now that feed alone settles flat on the plane through its centre that faces the eye, keeping the spread it had, the camera frames it again, the idle spin rests, and the space behind keeps its depth. Outside a feed the whole space flattens as before. Each feed is entered in 3D; BACK leaves the flat reading with the feed. orrery gains `flat_set(ids)` / `flat_get()` (a new graph ends it) and the `flatPositions_of` layout behind them.

## 0.22.2

### Patch Changes

- ff80b59: A shared feed's `data` opens again. Listing a /proc link into a feed another user owns walked the owner's home asking for links, and that refusal, a side question, marked the whole `ls` an error though its listing came. chili's path walk no longer leaves its link probe's refusal on the error stack; it remembers the parent it could not read instead. When a listing then fails, `ls` says so after the reason (`ls: links in '/home/<owner>' could not be read; the path was walked as written`), because a link there, unseen, may be why the path was not found; when the listing succeeds nothing is said. ARGUS's files panel draws a listing the kernel sent even when the command is marked an error, and a refused press reads every line the kernel said, so the note reaches the bar too.
- 39ffe27: ARGUS ships the LCARS sounds. The four beeps (press, arrive, retreat, refuse) are committed as `public/sounds/*.mp3`, so every install plays them; the synthesised `.wav` remain only as the fallback for a missing `.mp3`. Previously they were extracted per machine and a published install fell back to the synthesised beeps.

## 0.22.1

### Patch Changes

- 5bbe0d1: GATHER no longer fails silently. A cohort holding a gathered place (from the console's `gather add <dir>`) has no description, and the listing façade threw on that empty cell, taking every later GATHER down with no notice; the façade now draws a missing fact as empty text, and a gathered place reads as its path. The PACS query form's study terms (DATE, ACCESSION, MODALITY, SERVER) now stand over their caps; the form ended 68 px wider than the study rows.

## 0.22.0

### Minor Changes

- 51315ec: The calypso daemon knows when it is stale. It fingerprints its own packages' code (version and compiled scripts' content) when it starts, reads the fingerprint again on every attach and once a minute, says `stale` in its attach ack, and pushes a `stale` message when the answer flips. ARGUS says CALYPSO DAEMON OUT OF DATE only when the daemon says so, so an ARGUS-only release no longer alarms every running daemon; an open ARGUS learns of an upgrade within a minute. A daemon too old to report `stale` falls back to the build-stamp comparison.
- fe4b6b4: The calypso daemon is restarted by its own operator, behind a door. A RESTART pill stands beside LOG OUT, and the out-of-date notice's cure "Restart the calypso daemon" is a control. Both ask first in the notice's spot ("Restart the calypso daemon? You'll stay logged in; …"), naming what a restart would cut off right now: the running command, unsaved edits, other attached browsers and chells. YES asks the door to restart and follows the greeter back in; another ARGUS on the session says why it dropped and follows on its own. The daemon's heartbeat now lists the attached surfaces (id and kind) and its attach ack gives each surface its own id.

### Patch Changes

- 2d26368: Four defects the smoke suite's reds were hiding, fixed. `feed rm` now drops the feed from the session's index at once, so the RUNS roster stops listing a feed this session removed. The RUNS pane records the cwd on every promptline, so a pick is no longer replaced by a stale "move" minutes later. A follow superseded by a hand pick no longer takes the pane when its answer arrives late. RUNS pressed over a graph now leaves the graph whole (watch released, title and canvas cleared), and a feed listing brought by another command no longer pulls the roster over a graph.
- Updated dependencies [51315ec]
- Updated dependencies [33e4f1d]
- Updated dependencies [fe4b6b4]
  - @fnndsc/menu@0.17.0

## 0.21.1

### Patch Changes

- 1663bba: A run OPENed from the DAG listing and left by Esc comes back to a roster with nothing lit. The press's acknowledgement (the lit row and the dimmed rest) waited for the roster's own rows to settle it, but a run's answer is its graph taking the pane, so the row stayed lit, the rest stayed dimmed, and no press could clear it. The DAG pane now settles it when the graph lands, when the feed is refused, or when Esc backs out before the graph arrives.

## 0.21.0

### Minor Changes

- 685ed59: ARGUS and the calypso daemon say when they are different builds. ARGUS's build writes its stamp into the bundle; the calypso daemon reads it once at start and reports it in its attach ack (`stack.surface`, optional in the wire schema). When ARGUS's own stamp differs, it says which is older and what to restart — on the status strip, in a dismissible notice, and on the console: "ARGUS is newer than the calypso daemon, so some controls won't work. Restart the calypso daemon." or "ARGUS is older than the calypso daemon. Refresh to load the new ARGUS." A remote chell prints one line at attach when its build differs from the daemon's.

### Patch Changes

- Updated dependencies [685ed59]
  - @fnndsc/menu@0.16.0

## 0.20.0

### Minor Changes

- 4128890: A scrolling field answers its edges, as a phone's list does. Meeting the top or the foot — a scroll come to rest there (the wheel, a finger, an N MORE press that reaches the end), or a wheel or finger pushing past an edge the field already stands on — flares that edge in the theme's hue and gives the field's contents a small bounce. Every field that wears the MORE chip gets it, through `more_wire`; the script only says which edge was met (`data-edge`), the stylesheet draws the flare and the bounce, a spinning wheel is one meeting, and nothing moves under `prefers-reduced-motion`.

## 0.19.0

### Minor Changes

- e057d20: ARGUS edits a file in a pane (#831, slice 3). The kernel's `edit <file>` (and `feed note edit N`) opens an EDIT pane beside the focused one: CodeMirror 6 as a guest field, loaded on demand and painted from the theme's tokens; SAVE and REVERT on the mode frame, lit only while the field differs from the file; the bar says DIRTY or SAVED; Ctrl-S saves and Esc gives the keyboard back. Every save is the line the operator could have typed, `touch --withContents='<text>' '<path>'`, echoed and run, so the transcript holds each save and a feed's note is written through its projection. A second `edit` of the same file finds its pane and keeps unsaved changes; a desktop card brings the pane back on its file. brasa fixes found on the way: the semicolon splitter honours a backslash escape (an escaped quote no longer ends the quoting, so a later `;` inside it no longer splits the line), and an empty value is a value (`--withContents ''` writes an empty file instead of touching the empty word as a path).
- 2826f2b: A text file offers EDIT (#831, slice 3b). A file row whose extension is not on the binary list offers EDIT in ARGUS, a feed's note seen through `/proc` included; it runs `edit '<path>'` as a visible line and the kernel opens the editor pane, asking first for a file of a megabyte or more. The binary list moved into the contract package (`EDIT_BINARY_EXTENSIONS`, `path_isEditable`, `EDIT_CONFIRM_BYTES` in @fnndsc/menu), read by the kernel's `edit` for its refusal and by the surface for its offer, so the two cannot disagree. `feed note edit` help now says it edits in the surface's editor. New `docs/cube-feed-coverage.adoc`: each part of a CUBE feed, the kernel verb or path that reaches it, and the known gaps (rename, group permissions, revoking a grant, making a feed private again).
- c1cf57e: An edit crosses the wire to a browser (#831, slice 2). The daemon's `edit` request now names the file being edited (`path`), and a surface may answer `opened`: it took the file into an editor that stays open, so the command saves nothing and says `(opened in the editor)`; each save made in that editor will run as its own command line. The argus client hands an edit to a host editor hook and answers at once that it opened, or refuses in words when it has none (the hook is installed by the editor pane, slice 3). `feed note edit N` is now `edit /proc/jobs/feed_N/note`: a terminal's editor and a browser's pane open the same text and save it the same way, and the title is set with `feed note N --title`.
- 50d41d7: ARGUS shares and renames a feed (#853, slice 2). A feed row offers RENAME (and so does an entered feed's graph frame): it asks for the name with the one it has and writes `/proc/jobs/feed_N/title`, and the graph's bar reads the new name at once. SHARE asks a choose question: the CUBE groups you belong to (from /etc/group) and EVERYONE as pills, the ones that already hold dimmed, and a field for a user; each pick runs `setfacl -m` visibly and the question comes back until DONE. The row's SHARED WITH readout becomes marks — each user, each group, and PUBLIC — each with a × that asks "Stop sharing feed_N with …?" before `setfacl -x` (or `setfacl -m o::-`) runs. The listing façade's readout takes an element as well as words; a choose question's pill can carry a label and the bar wraps when its pills outgrow a line. Fixed on the way: a press in a pane's question bar retracted the mode frame and dropped the row's indication, and consecutive visible lines' answers piled into the first one's console block.
- 51da853: ARGUS shows and changes a feed's tags (#831, slice 4b). The kernel's roster model (`feed.list`) carries each feed's tags from the cached tags index (one read per tag, never per feed). The runs roster marks a feed with its tags after its title, in one theme hue; a press on a mark filters the roster by it (`tag:`, a new filter-only term in the listing façade), and its × on the indicated row takes it off. A feed row offers NOTE (the editor on `/proc/jobs/feed_N/note`) and TAG. TAG asks a new `choose` question: your tags as pills (the worn ones dimmed), a field for a new name, DONE to end; each pick runs `setfattr`, a new name `mkdir /proc/tags/<name>` first, all as visible lines, and the question comes back with the tag held. A graph on stage reads its feed's note and tags when entered and shows ADD NOTE or EDIT NOTE, TAG and the marks under BACK, re-read after an editor save. A note is never read for the roster (CUBE's feed list says nothing about notes: ChRIS_ultron_backEnd#737).

### Patch Changes

- Updated dependencies [2826f2b]
- Updated dependencies [c1cf57e]
- Updated dependencies [51da853]
  - @fnndsc/menu@0.15.0

## 0.18.15

### Patch Changes

- d635b67: A question that stands on a pane stands on the console's line too (#826): RUN's feed title, a delete's confirm, MKDIR's name, a cohort's name are answered on the pane or at the prompt, whichever comes first, and the other place closes. An answer typed at the prompt no longer runs as a command while the pane waits.
- 60530c8: The DOWNLOAD smoke proves what ARGUS owns (#830): the name and bytes the page hands the browser to save, and nothing handed over for a file the session cannot read; headless Chromium saves no download at all, so the disk proved nothing about the surface. The smoke driver's CDP calls now reject with the method and the browser's words when refused, instead of resolving as if they had worked.
- a414a4a: The PACS query form stands on its listing's grid again (#825): the form has a cell for the listing's control column, so PATIENT and MRN are typed over the PATIENT and MRN they fill; the levels read their shared leading tracks (fold, PATIENT, MRN) from one declaration, and the aegis lint holds the levels and the form to it.
- ef43797: The older-page notice speaks plainly (#837): "ARGUS has been updated in the background — refresh this page", where the word "refresh" is the link that reloads; the console says the same sentence, and the smoke reads the words from the module so the two cannot drift.

## 0.18.14

### Patch Changes

- e5f44e8: Cleanup, slice 2h: the browser — the files pane as the host builds it, its readers and preview provider, its rooted listings and history, its binding to the cwd, delivery and MKDIR, its row and selection verbs — is a module of the host (`app/browser.ts`, `browser_wire(context, hooks)`), its path readings exported and unit-tested. No behaviour changes.
- 790daf6: Cleanup, slice 2i: a pane's chrome — the drawer behind its handle (the binding radio, SPLIT and MOVE with their direction capsules, chord titles, CLOSE) and the children a kind adds (a browser's CWD binding and frame verbs, a graph's node and feed verbs) — is a module of the host (`app/paneChrome.ts`, `paneChrome_wire(context, hooks)`), one named function per part. No behaviour changes.
- 3620f4d: Cleanup, slice 2j: the console language's host — what a typed sentence may do to the stage: focus and the pane verbs, the opens, the image and tags verbs on the pane a target stands for, a desktop serialized as the lines that put it back — is a module of the host (`app/consoleHost.ts`, `argusHost_build(context, hooks)`); the "itself, its group's, or the only one on stage" resolution, spelled twice, is one function. No behaviour changes.
- c1bc5b4: Cleanup, slice 5a: the UNIVERSE pane's `control` (one run of fifteen `if (verb === …)` blocks, 138 lines) is a table of named verb methods, and its constructor's frame pills and Esc are wirers of their own; the DAG pane's `envelope_observe` hands an indexing answer and a graph to two named takers. The aegis lint holds every argus function under 150 lines and every file under 1,200 (law a-part-stays-a-part), a module factory measured by the functions inside it and what still stands past a ceiling named with its reason and capped where it stood. No behaviour changes.

## 0.18.13

### Patch Changes

- 403e480: Cleanup, slice 2e: where a question stands — on the pane that provoked it, as an errand beside it, or on the console when no pane can carry it — is a module of the host (`app/asks.ts`, `asks_wire(context, hooks)`): the errand host, the errand, its abandon, the pressed verb's pane and the pane ask. No behaviour changes.
- 0da0f73: Cleanup, slice 2f: a /bin entry as the graph it is — the pipeline's and the plugin's readers, the stage, the dive into a node, the readout painter, the form a bound catalogue makes of it and the diagram's mode frame — is a module of the host (`app/binView.ts`, `binView_wire(context, hooks)`), its pure parts exported and unit-tested. No behaviour changes.
- 403e480: Cleanup, slice 2d: the session's cohort — the header band, the GATHER pane, the file it is kept in, its reveal and retreat — is a module of the host (`app/cohort.ts`, `cohort_wire(context, hooks)`), and the band's and the pane's handler sets, spelled twice before, are one set parameterised by where the work lands and where a question stands. Stage verbs unit-tested in jsdom. No behaviour changes.
- ea8003e: Cleanup, slice 2b: the desktop — the stage captured as a script of console lines and replayed, with the births the opens record and the replay place they read — is a module of the host (`app/desktop.ts`, `desktop_wire(context, hooks)`), its capture split into one action per pane and its replay into one step per action, unit-tested in jsdom with a recording stage. The host hands it its open verbs as hooks and keeps its call sites. One dead constant (console sub-verbs no one read) removed. No behaviour changes.
- 0bdc87c: Cleanup, slice 2g: the keys the stage answers — Esc as a ladder of named steps retreating one level a press, the prefix chords, the prefix itself — are a module of the host (`app/keys.ts`, `keys_wire(context, hooks)`), the command line, the errand, the dives and the chrome its hooks. No behaviour changes.
- 0b90f54: Cleanup, slice 2c: inside a node — the rooted browser over the canvas once the camera has flown into a sphere, its hops, its way out, Esc's two levels and BACK — is a module of the host (`app/nodeOverlay.ts`, `nodeOverlay_wire(context, hooks)`), the host's files body, rooted listing, row verbs and file readers its hooks; the host context stands above its first module now, the layout and the dormant groups read when called. The image-panes smoke scenario enters the FILES domain before it opens the viewer, which its restore check assumed. No behaviour changes.

## 0.18.12

### Patch Changes

- 92cc3e8: Cleanup, slice 4: the UNIVERSE pane's descent, climb, cluster and plugin framing are one scene word each (`descent`, `frame`, `unfold`, `relight`), and its own `flying` flag is gone for the scene's `moving()`; the DAG pane reads a feed's model into scene nodes through `features/dag/sceneGraph.ts` (`dagGraph_build`, `dagMetric_of`, `hueLegend_build`), pure and unit-tested. No behaviour changes.
- ff537bd: Cleanup, slice 2a: the host's eight panel maps are one roster (`PanelRoster` in `app/panes.ts`: filed by pane id, read by kind), the host has a context its modules read (`app/hostContext.ts`: layout, panels, pane instances, subjects, dormant, sound, and the terminal and client read when called), and the first module is wired through it: the pane verbs (`app/paneVerbs.ts`: a bar note, move, flip, resize, the chord keys for a title), unit-tested in jsdom. No behaviour changes.
- 65248d0: Cleanup, slice 1: four facts the surface spelled in many places have one source each — the sides (`app/sides.ts`), the pane bar's states and their writer (`features/roster/bar.ts`), the primaries and the pane kinds as a union (`app/panes.ts`) — and the aegis lint fails any file that spells them again. No behaviour changes.
- 1003267: Focus names a pane on stage: after a preset change the layout's focus could still name a pane that had left (the launcher), so the HELP tile and `pane split` from the focused pane opened nothing (#816). A tree that loses the focused pane now hands focus to its first leaf.

## 0.18.11

### Patch Changes

- 72a7ccc: Help lives on the stage: a HELP pane (the prefix chords and the verbs as a listing, filterable) opens from a HELP tile on the dashboard and from the typed `help pane`; `help keys` and `help verbs` print the tables in the console. The keys reference `docs/keys.adoc` is generated from the one chord table (`npm run docs:keys`) and the aegis lint holds it to the table.
- affc300: The rest of tmux's table as prefix chords: `;` the last pane, `q` every pane's `@id` on its bar, Space flips the pane's split (beside becomes above), `!` breaks the pane out (alone on stage, the arrangement it leaves a PANES card), Ctrl-arrow moves the boundary beside the pane a step (the first keyboard resize: `pane resize left|right|up|down [percent]`), `w` PANES, `[` the console's scrollback takes the keys; `pane flip` and `pane focus last` as verbs.
- 629c1c3: Prefix chords: with a pane's drawer open (Ctrl-B), one key presses one of its capsules — tmux's `%` `"` `z` `x` `o` `:`, `h j k l` to split, `H J K L` to move the pane, `m` to arm MOVE, `u f v` the binding, `1 2 3` the claim, `?` the table — and the arrows focus the pane in that direction; Tab still walks the verbs. Each capsule's title names its key; `argus keys` prints the table.

## 0.18.10

### Patch Changes

- 88437cc: A tab icon: the ChRIS mark on the page's own ground, for the surface and for the door.
- 55fbf6c: Every scrolling field says it holds more: the node readout immersed in a DAG, the errand pane's answer, the dashboard's tiles, the PANES desktop, the slaved viewer's body and the PACS workspace now wear the `▼ N MORE` chip and hide their scrollbars like the listings, the file view, the band and the frames already did; the gather pane's and the CSV table's mounts no longer scroll around the listing field inside them. `MORE_FIELDS` names every scrolling field and the aegis lint holds the stylesheet to it. And an opened image fills its field keeping its shape (`object-fit: contain`) instead of being stretched to the width under a 60vh cap.
- 40acb72: A pane can be moved: the drawer's SPLIT label is a pill now, beside a new MOVE pill, and the four direction capsules act under whichever is lit — SPLIT opens a new pane on that side as before; MOVE (one press, then the drawer falls back to SPLIT) moves this pane there, detached and re-split onto the nearest block on that side, a side it cannot go dimmed first. The mover keeps focus and its bar reads MOVED <SIDE>; `pane move left|right|above|below` is the same verb typed, refused by name ("already rightmost", "the only pane on stage").
- d7ec90d: A moved pane returns where it was moved to: a desktop card and a dormant group record the stage's tiling at dormancy (leaves as action indices) and lay it over the replayed panes, since a birth alone cannot say "beside that whole block".
- d057e99: The layout tree learns to move a pane: `leaf_move(pane, side)` detaches the pane and re-splits the nearest block on that side (the former sibling when none), opening even; the only pane on stage and a pane already at that edge are refused by name. The drawer's MOVE pill and the `pane move` verb follow.
- 4863f32: A frame pill answers on its pane's own bar: the UNIVERSE layout, captions and replay pills had narrated their one-line answers into the console as notes (a cycle through the layouts filled it with their descriptions, no command typed); the answer now holds the pane's state bar for a moment and the standing readout returns, and the console carries only what was typed or asked there.
- 8260d33: A press is acknowledged: the activated row lights and the rest dims, its capsule works, and the pane bar reads `OPENING <name>` until the listing lands or the kernel refuses (then the reason, on the bar); a repeat press on the same row is absorbed.
- Updated dependencies [4864a34]
  - @fnndsc/menu@0.14.0

## 0.18.9

### Patch Changes

- 8b9b990: A field that holds more than it shows says so: every scrolling field (listing, frame, file view, band) hides the browser scrollbar and wears a `▼ N MORE` / `▲ TOP` chip at its foot, through one façade helper.
- b381cd5: A file's content view scrolls inside its pane instead of running past its foot; the header band's grip stands (and breathes) on the resting face too, so the band can be dragged before any face is chosen.
- 5c31b8b: A page older than the server's build says so where the operator looks: the image pane reads `ARGUS WAS UPDATED ON THE SERVER · RELOAD THIS PAGE` on its field instead of failing silently, and the page notice says what it is and the cure; the stale chunk is no longer swallowed into a TypeError.

## 0.18.8

### Patch Changes

- cbd71cc: A refused file read says why: the kernel names the status and reason (403 not yours to read, 404 no such file, 502 CUBE could not serve it), `/vfs` answers with them instead of 404 for everything, and an image pane that lost a slice reads the reason out. `porter --end <who>` ends one session so the next login boots on the current kernel.

## 0.18.7

### Patch Changes

- 08e85b7: BACK heads the graph pane's frame (to the roster, or asks for one), and a tap on the node facts plate's own ground stands it down — a phone has no Esc and the plate reads as background.

## 0.18.6

### Patch Changes

- 74eb31e: In the 2D projection a node's disc is drawn on its tubes, not under them: the disc draws after the tubes without the depth test, as a sphere's near hemisphere covers a tube end in 3D.

## 0.18.5

### Patch Changes

- 1f0b0bf: Header band and listing nits: Esc retracts the band's frame with the panes'; a frame that holds more blocks than its field is tall says so with a `▼ N MORE` chip instead of a scrollbar, and an indicated row no longer scrolls its field sideways; a finished pull paints the full bar with its count (not the word PULLED) and a rebuilt cohort row keeps it; a JSON file opens pretty-printed and highlighted with RAW / PRETTY.

## 0.18.4

### Patch Changes

- 98b59e8: The cohort listing takes the PACS series listing's index hue, and an indicated row's progress bar keeps its colour inside a black well, so a 100%-pulled selected series no longer reads as unfetched.

## 0.18.3

### Patch Changes

- bbf8ce0: The header band says when it holds more: a cohort longer than the band shows `+N MORE · ON STAGE` at its foot (pressed, the whole cohort goes on stage), and the band's drag grip is visible at rest and takes a finger.

## 0.18.2

### Patch Changes

- ba34698: The console's foot (and the header band's) resize by touch: the drags follow pointer events with the pointer captured, the strips take `touch-action: none`, and the console's thin strip takes a touch across a finger-sized band.

## 0.18.1

### Patch Changes

- 7645517: A node's view has a way out without Esc: at the node's root the listing's way up reads EXIT NODE and leaves the node, and EXIT NODE stands first on the node's frame. The separate INSIDE strip is gone; the node's browser covers the pane's frame, so one frame and one elbow stand.

## 0.18.0

### Minor Changes

- fbd3f0a: The session lays the universe out itself: once the index is whole the daemon runs orrery's engines for every layout in a worker thread and keeps the places (`proc layout <name>` reports `laying` progress meanwhile). orrery is published; `layoutInput_build` builds the engines' input one way for browser and session, and the universe graph builders live in `@fnndsc/menu`. ARGUS waits on the session's progress instead of settling the same space, keeps places only for the view on stage (SHAPES apart), redraws a view already seen where it stood, and gives the session only default-physics places.
- fbd3f0a: Data facts reader v2: a series in CUBE's PACS store is described by CUBE's own series record (asked once per patient) before any header is read, and each feed records `sourceFeed` when its data lies in another feed's output. Under DATA that lineage is drawn as a faint thread from the source feed's root (`joinFaint`: a thread, never a tube).

### Patch Changes

- Updated dependencies [fbd3f0a]
- Updated dependencies [fbd3f0a]
  - @fnndsc/menu@0.13.0

## 0.17.0

### Minor Changes

- 0f9ae74: The universe laid out once per identity: `proc layout <name>` answers where a surface last laid the universe out under a layout, and `proc layout put <name> <places>` keeps it beside the index checkpoint. ARGUS puts each settled layout and, in a browser that keeps none, draws from the session's copy at once, settling only feeds new since.
- 7c1250f: ACCRETION on the universe's LAYOUT block (`universe layout accretion`): the space grown in the order it was made, each feed sticking to kin (feeds that ran the same plugins) more readily than to strangers; later feeds accrete without moving anything; `universe regrow` grows it afresh.
- 16f8558: CAPTIONS on the universe frame (`universe captions on|off`): the hubs' words over the picture drawn or not, kept with the other frame choices; captions sit on a dark plate so they read over a bright cloud.
- 8851db3: CONSTELLATIONS on the universe's LAYOUT block (`universe layout constellations`): every plugin a ringed star placed by what runs with what, every feed pulled to the stars it ran; a star's tip reads `pl-x · n feeds · e% errored`.
- e59a8d7: DATA on the universe's LAYOUT block (`universe layout data`): every feed hung from what it began from — a hub per format, then per DICOM modality, then per series-description group — each hub a captioned nebula sized by its feeds; a hub's tip reads its path and count, a press lights its feeds.
- 8cd7a3a: REPLAY on the universe: the space's history played back feed by feed in the order they were made, each shown with a flash where it stands now and the day on the bar. A block on the mode frame (REPLAY, PLAYING, PAUSED, REPLAYED), `universe replay [speed] | pause | stop | at <date>`, and Esc ends it. Needs a daemon that dates its feeds.

### Patch Changes

- a0927ec: In CONSTELLATIONS a plugin star is a handle: a press lights the stages it ran across the sky and shows its facts with OPEN IN /BIN, a double press frames them, and `universe plugin <name> | off` does the same by word. A study folder handed to the surface's image opener finds its series again (it read the listing's shape wrong).
- e61a6ad: On a touch screen, pinching out of an entered feed or cluster climbs out one level, as a double tap went in: once the camera stands half as far again as the descent framed it. A smaller pinch, to see a feed whole, stays. BACK stays on the mode frame.
- d1da8ac: `proc universe` carries what each feed's data is (`data`: format, and for DICOM modality and series description) once the index has read it. The reader follows a copy job's links (to files and to folders), reads newest feeds first, four at a time, gives a feed that never answers 45 s before moving on, records a DICOM-named file whose header will not read as DICOM with the reason, and stamps each record with its reader's version so a better reader reads feeds again.
- 5aec39e: Each universe layout keeps its own places again: a switch no longer files the current space under the layout it is switching to, which made every layout recall the one before it.
- Updated dependencies [d1da8ac]
- Updated dependencies [0f9ae74]
- Updated dependencies [d8e160c]
  - @fnndsc/menu@0.12.0

## 0.16.5

### Patch Changes

- ac55e18: DOWNLOAD saves the file or says why not. The page fetches the file with its own credentials and saves only an answer that is the file, under the name the daemon gives it (else the path's basename); a login page or a `not found` is no longer saved as a broken file named `vfs` — nothing is saved and the console says why.
- a46fe8b: A dropped slice is asked again: slices load eight at a time, each refused one is retried three times with a growing pause, one with no answer in 30 s counts as refused, and whatever is still refused puts RETRY n on the image frame to ask again for just those.
- f319057: ZOOM on an image only zooms: a one-finger drag under ZOOM panned the view, because the library's zoom pinched and panned by default. `image state` prints what the field shows (layout, tool, slice, and per viewport its scale, focus and window), and the smoke drives every frame block by mouse and by finger and reads the field back.
- 7b4853b: On a phone the listing caps no longer run under the mode frame's elbow, whose black fillet cut a notch out of the PATIENT cap: caps clip at their own clear line. The PACS command line wraps, so EXPORT CSV is no longer cut off at the pane's edge.
- d9fc76f: The universe lands the same way on every device: each molecule's turn in the galaxy, spokes and clumps layouts is seeded from the molecule itself, so a lab's universe is repeatable and a new feed turns no other.

## 0.16.4

### Patch Changes

- aff458c: A census drawn as spheres joins its jobs with tubes and pulses, as a feed's stages are joined (up to 20,000 edges; lines beyond).
- f2ef100: The frame meets itself on every screen: the header's band sits level with the gutter's elbow at any height (it broke on screens shorter than about 1000px), and a long pane title no longer pushes the panes past the right edge — the title ellipsises and a drawer's verbs wrap.

## 0.16.3

### Patch Changes

- e847e49: The frame on a phone: below 700px the gutter slims to a rail read by number, the header's ARGUS WEB face (audio, theme, versions) folds behind a ≡ pill, the dashboard stacks its blocks in one scrolling column, and nothing holds a desktop width — the right side no longer runs off the screen.
- cb01d69: Touch: the universe and DAG panes take a pinch to zoom, two fingers to pan, one to orbit or pull, a tap to select and name, a double tap to enter; the image pane steps through a series with two fingers up or down.

## 0.16.2

### Patch Changes

- 53d43f6: `mkdir` follows POSIX: `-p`/`--parents` makes missing parents and accepts an existing folder; without it a missing parent is "No such file or directory" and an existing folder "File exists". `rm` says "Is a directory" for a directory without `-r`, reads `--recursive`/`--force`/`--interactive` whole, and stays silent on `-f` of a missing operand. `mkdir`, `rm`, `cp`, `mv` and `touch` refuse an option they do not have, by name, instead of skipping it or taking it for a path. argus ensures `~/gather` with `mkdir -p`.
- 38572b6: Tubes follow a pulled node and a pull no longer explodes the feed; tubes are the DAG pane's default edges; a finished feed's pulse replays in a cycle, lighting each stage with a blooming glow as the pulse lands; a running stage blinks with its stream until done; the feed on stage arriving again with the same shape patches in place instead of resettling.

## 0.16.1

### Patch Changes

- 44fd994: argus: DICOM and NIfTI views load again. The image engines glued the page's origin to a byte URL that answers relative since the surface went under a prefix, making every slice an invalid URL (`http://host:4180vfs?…`); they now resolve it against the page. In the universe, a click takes the star the tip names — the space holds still under the pointer — and the camera flies toward it, frames the entered feed whole, and draws its edges as tubes thick enough to read. Under CENSUS, an entered feed now stays solid spheres in tubes and the camera no longer re-parks on every rebuild; `universe state` reports what the pane holds.

## 0.16.0

### Minor Changes

- 5ccff72: argus: the universe settles in a worker — off the page, and running in a hidden tab. A LAYOUT block (`universe layout galaxy|spokes|clumps`): GALAXY (default) lets the space find its own emergent shape, now started near rest (26,000 spheres in about 90 s instead of 150); SPOKES fans every feed out from its hub and CLUMPS packs them, both as a hierarchy in seconds. Each layout keeps its positions, so returning to one already seen redraws at once. Up close, edges are lit tubes carrying pulses from parent to child: live edges stream, a finished feed fires one wave in run order. The wait readout now truly disappears when a settle ends (it used to stay on screen at its last figure); a near feed turns solid by its nearest sphere, and a star never swells past 28 px.

## 0.15.0

### Minor Changes

- 5caeef6: argus: the universe draws stars. A STARS / SPHERES block on its frame (STARS by default; `universe draw stars|spheres`): every node a point of light at its sphere's true size, errored ones drawn as embers over the glow so red stays red, edges as faint threads, a cluster's halo as a nebula glow that is still its handle; an entered feed stays solid, and CENSUS draws its members as stars. On the GPU the same space went from 20 to 60 frames a second. The frame's four choices (draw, view, scale, density) are now kept per identity.

### Patch Changes

- b92c96a: argus: under STARS, a feed near enough to read turns solid as a whole — past about seven pixels on screen, back to stars below five — crossfading its stars into lit spheres and its threads into edges. Its spheres exist only while it is solid, so detail follows the camera and the frame stays at 60 fps.
- d6dac25: argus: a page older than the build its server now has says so. When a tab loaded before a deploy asks for an on-demand chunk the server no longer has (the image engines load this way), argus writes one console line and shows a notice over the stage, "ARGUS WAS UPDATED ON THE SERVER — THIS PAGE IS OLDER", with RELOAD. It used to fail silently: an image pane never opened.
- 6233301: argus: a wait over two seconds shows its progress (new AEGIS law). Opening the universe no longer holds the page: a large settle runs in slices with a bar over the field (`SETTLING 3,034 SPHERES · 43%`), and the field says `ASKING THE SESSION FOR THE SPACE` until the answer arrives instead of a title claiming `0 FEEDS`. A space re-shown with remembered positions (a login, a reload, the climb out of a feed) appears at once, and a landing during a sweep settles only its own molecule.

## 0.14.0

### Minor Changes

- f3f68e3: argus: every job in the universe. A DENSITY block on the universe frame (and `universe density shape|census`) draws every job of every stage as its own point in one instanced mesh, shelled around its stage; hover and click still name the stage beneath the pointer. A cluster's halo is never shelled as jobs.

### Patch Changes

- b254ee4: argus: a click in the universe no longer re-settles the space. Selecting a node only paints it (it used to rebuild the scene and refit the camera — the zoom-out and pause before every descent); the dimmed field behind an entered feed takes no pointer, so a click or double click inside always lands on the feed's own node; a space re-arriving keeps a camera the operator has placed and is held during a descent; the bar reads ENTERING FEED n with the pill ASKING while `feed diagram` runs, and an ask that yields nothing says so on the console; inside a giant feed the camera frames the bulk of the nodes, not the outliers.
- 11a0dd1: argus: inside a feed in the universe, ENTER NODE (and a double click on a node, and `universe node <instance>`) flies into the node and opens its data inside it as a rooted browser; Esc flies out. It used to move the session's cwd, which said nothing on the field.
- cb76c3b: argus: the universe turns about what the camera looks at. The idle spin, the orbit, the wheel and the pan pivot on a focus set by every fit and flight, so an entered feed stays in the middle of the frame when the spin resumes. Entering a feed or unfolding a shape no longer freezes the page: the settle simulates only the nodes that move and spheres share geometry (about 10 s down to about 1 s). A pull on a sphere moves only its own molecule, and a dimmed halo inside a feed takes no pointer.
- f2b6a80: argus: the universe pane gains a GRAVITY block and `universe physics charge|link|collide|gravity on|off` / `universe physics reset` by word, the DAG pane's knobs for the space.
- f297468: argus: the file browser's way home is one press. A `~` row leads the listing above `..` anywhere but home, showing the home path beside it, and the path line above the listing is a trail whose every segment but the last goes there (starting at `~` under home, `/` elsewhere). Both move the browser exactly as a directory press does.

## 0.13.0

### Minor Changes

- 5b78288: argus: the universe can fold across feeds. A VIEW block on the frame (and `universe view feeds|shapes`) switches the top between every feed as its own molecule (the default, the whole compute structure) and one molecule per pipeline shape, sized by the feeds folded under it and reddened by how many of them erred at each stage; a click on a folded shape unfolds it into its members in place. The scale block's second word is now ALIKE.

### Patch Changes

- 5a95cac: argus: the UNIVERSE takes the stage — its own preset and primary pane, entered whole from the dashboard tile rather than split beside a browser — and its frame opens to the bar's width like every other field's, so the blocks stay on screen.

## 0.12.0

### Minor Changes

- de26df4: argus: a cluster has a handle. Every shape's anchor in the UNIVERSE is drawn as a halo sized by the feeds it gathers; hover names the shape and its count, a click brings the cluster into view (the shape lit, the rest dimmed, the camera framing it), BACK or Esc returns; `universe cluster <feed>` from the console. A feed entered from a cluster climbs back to the cluster.
- 637c819: argus: the descent into a feed. A click on a sphere in the UNIVERSE flies into its molecule, unfolds the feed into its graph in place (the kernel's own collapse as the budget) while the rest of the space dims, and frames it; inside, a node's facts and verbs (ENTER NODE, PROCESS), OPEN FEED into a RUNS pane, Esc or BACK to climb out. `universe enter <feed> | back | open` from the console.
- c82f514: argus: the UNIVERSE is its own pane. Opened from the dashboard's tile beside the errand host, one per stage; RUNS-02 stays a feed viewer. Hover over a sphere names the plugin group and the feed it belongs to. The space breathes after the index is whole (arrivals drift in, status changes recolour, gone feeds leave), hugs a lone molecule instead of scattering it, and remembers where its molecules settled per identity across reopen and reload.

### Patch Changes

- dac2d96: argus: the console opens on the ChRIS brain at rest and the session's greeting from `motd ARGUS` — name, feeds, jobs, failure rate, what is running, a fortune — in place of "two projections of one CALYPSO session".
- 50f8a4e: argus: a sphere in the universe weighs its jobs on a log scale and is hued by the share of them that failed, not by the worst one; the tip says how many errored; a SCALE block (JOBS / FEEDS) joins the frame. An 80,000-job group with a dozen failures no longer eats the field as one red giant.
- Updated dependencies [dac2d96]
- Updated dependencies [50f8a4e]
- Updated dependencies [c82f514]
  - @fnndsc/menu@0.11.0

## 0.11.0

### Minor Changes

- 50f358b: ARGUS: a cohort can take the stage, as a second view of one set.

  A band is right for reading and curating a cohort and wrong for two hundred members with a filter on. The band's frame carries ON STAGE, which puts the cohort on the main panel as a pane and retracts the band.

  What makes that a second view rather than a second cohort is that the set moved out of the panel. A `Cohort` holds the members, the name and the feed, and tells whoever shows it when it changed, so two panels render one set: removing a member in the pane empties the row in the band without either telling the other.

- 149957f: ARGUS: the cohort rides the header, as the session's own.

  A cohort spans PACS series and will span directories, so it never belonged to a pane — and opening it as a companion pane rearranged the workspace on every gather. It is now the header's third face, on the mechanism the other two use: a button selects it, pressing that button again sends the band away, and the workspace never moves either way.

  The face is a proper field, rule and elbow and spine, because a cohort is a listing: its rows' verbs ride the row zone and PULL and REMOVE ride the frame.

  The band is one height for every face, since a face that sizes to its content moves the workspace beneath it. The boundary it shares with the body is a drag strip with the console drawer's rules read from the other side, and the height is remembered.

  Gathering reveals the band the first time and then respects a dismissal, moving only the count on the button. The cohort is kept in the session at `~/gather/current.json`, so a refresh keeps it and a second surface sees the same one; SAVE still writes the named manifest.

- 161e54d: ARGUS: a cohort shows what a series shows, and a frame pulls what it holds.

  The GATHER pane described a series in columns of its own while the answer it came from used different ones. A cohort is an organized subset of that answer, not a second kind of thing, so one declaration now serves both: a gathered row carries the same SERIES, STATE, MODALITY and FILES columns as the PACS listing, state badge included, with MRN riding along because a cohort may span patients where a study's series never do.

  Both frames also carry the verb that acts on the whole listing. PULL n SHOWN on the PACS frame retrieves every series the listing is showing, which is the filtered set when a filter is on. PULL n on the cohort's frame retrieves the members CUBE does not hold yet. Each is one command over many operands, since twenty pulls is twenty lines to audit and the kernel already takes a list.

- 07f3783: ARGUS: a CSV opens as the table it is.

  A delimited file opened as a `pre` of quoted lines. It now opens as a listing: the header record becomes the caps, the records become rows, and it gets the frame, the sort and the filter every other listing has. RAW stands beside CLOSE for when the quoting is the thing being read.

  The file is read rather than split. A field may carry the delimiter, a newline or a doubled quote, and splitting on commas turns one such row into several wrong ones; `.tsv` is read by its tabs. A first record that is not a header — a blank, a repeat, or a bare number among its cells — is kept as data with the columns numbered, since inventing names out of values would hide a row. A ragged record is filled rather than refused.

  The view is bounded at five thousand records and says so when the bound bites.

- 0f3deaa: ARGUS: a file can be gathered.

  GATHER was a place-only verb in the browser, on the belief that a run is given a directory and a gathered file would be a member no run could take. Checked against CUBE's source rather than repeated: `pl-dircopy` copies nothing — its `--dir` is CUBE's `unextpath`, a comma-separated list of paths whose validation checks only that the caller may read each one, and whose runtime handles a file explicitly. Proved live: three files handed to dircopy became three link files at the feed's root, no copy made.

  So a file wears GATHER now, keyed by its path like a directory, and "three and only three files" is a cohort a run can be given. Not on a projection: a gathered view of /proc is a member nothing could hand over. The cohort's refusal of a mixed feed stands for one more slice, until the kernel gains a verb that hands a path list to dircopy, and its note now says that instead of claiming dircopy takes one directory.

- 369b20d: ARGUS: a cohort member has a kind, so a cohort can hold places as well as series.

  GATHER now stands on a browser's directory rows beside PROCESS, and a member carries what it is: a series, a directory, a file.

  The kind keeps the verbs honest, which is the point of having one. PULL is offered only on a series that is not home, since a place is already in ChRIS. IMAGE only on imagery, so a folder of tables is not offered a viewer. PROCESS on anything with a place. The cohort's bar counts what it holds — `1 SERIES · 1 PLACE` — rather than calling everything a series.

  CREATE FEED refuses a mixed cohort by name: a feed is rooted by pulling its members, a place cannot be pulled, and the kernel roots a feed on one directory rather than several. It says so and says what to do instead, rather than rooting a feed on the series and leaving the places out.

- 8a8dc25: A patient answers to a number: `@PAT001`.

  A PACS answer asked of two patients showed `1` beside each — the patient level had no kind, so it counted itself dim per group. Patients are now a kind of their own: `PAT001`, `PAT002` in their own sequence, lit on the pane, and `pull @PAT001` or `gather add @PAT001` hands a verb every series of every study of theirs, as the row's own GATHER does. A patient has no path of its own, so its address is minted from what names it (`patientAddress_of`, in the wire package, the same string on both sides); a patient the PACS answered nothing for has nothing to hand and wears no number.

- 1bdf876: A row wears the number it answers to.

  A row of the session's last answer can be named by the number beside it — `gather add @2,3,6`, `image @1` — so the number is now DRAWN beside it. The listing façade mints a leading index pill for any level that says how its rows are addressed, and no pane draws a number itself.

  What is numbered is the kernel's ANSWER rather than a rendering of it, so a console table and a graphical pane count the same rows. The lit number is found BY ADDRESS, not by counting down the screen, so a sorted or filtered listing keeps each row's own number instead of renumbering under the operator.

  Every listing leads with the column and every row counts itself; only the rows the kernel reaches wear a LIT number. In a PACS answer that is the series, while the patient and study levels above count themselves dim — the distinction is the hue, never the digits, so a number nothing answers to cannot be mistaken for one that does. Numbers are zero-padded to the widest in their group, so a fourteen-series answer reads 01…14 and the column stays a column. The lit hue is the pane's FRAME hue (`--listing-index-hue`, set per pane), because the pill is chrome and not content: an orange pill beside the browser's orange kind glyph read as one blob and the number stopped being a number.

  The surface learns which listing is numbered from a retained `numbered` message: brasa announces it as the answer changes, calypso relays it and replays it to a surface attaching late, and the addresses travel with it (capped, past which a long listing is numbered in the kernel and unnumbered on screen). The same shape regard already travels in.

  Law: `a-row-wears-the-number-it-answers-to`.

- 9cc1514: argus: a surface under a prefix.

  The daemon serves this bundle, its wire and `/vfs` from one origin at its root, and the page said so in absolute terms — `ws://<host>`, `/vfs?…&token=`. Behind a door (the porter, which will proxy one identity's daemon under `/s/<identity>/` on an origin every identity shares, over TLS) the root is somebody else's and `ws:` on an `https:` page is refused. Every address is now derived from where the page was served: the page's directory is the daemon's mount, the socket scheme follows the page's, and the byte route is `vfs?…` relative to the page. At the root nothing changes.

  A page sent through a door arrives at `…/?door` with no token, because the door holds the token and puts it on the proxied attach itself; the page attaches at once with an empty token instead of showing an attach form for something it is never told. A page that holds a token still puts it on its own requests.

- 3bbc65a: ARGUS: a study and a whole filtered table can be gathered, not only a series.

  The cohort is unchanged — it holds series — and what was missing were ways in.

  A study row carries GATHER when any of its series is home. It takes those and says in the transcript how many it took and how many are not in CUBE, since a set says what became of every member.

  The table's GATHER rides the frame, because it acts on the field. It reads `GATHER n SHOWN`, stands down at zero, and takes the series the listing is showing — which is the filtered set when a filter is on. It takes the series the filter left standing, never the studies they hang under: a study survives because a child matched, so sweeping its siblings in would gather exactly what the filter excluded.

  A filter also opens a row it kept only for a child's sake. A filter that hides its own matches behind a fold has not answered, and a verb that reads the field could not see them either.

- 1cb8d03: ARGUS: a field verb acts on the whole answer, a cohort reflects the pull, and it says which study it came from.

  PULL and GATHER read "what is shown" off the painted rows, and a fresh answer has every study folded — so the count was zero and the verb withdrew itself on exactly the table an operator most wants to act on. A fold is a way of looking, not a way of choosing. What is shown now means the filtered set while a filter is on, and the whole answer when none is; the blocks say which, reading `PULL 245` on a fresh answer and `PULL 16 SHOWN` under a filter.

  A cohort is a reflection of the same series, not a copy, so it moves with them. Badge elements are now a registry keyed by series UID holding every element standing for that series in any pane; a progress tick repaints them all. A cohort's row walks NOT RETRIEVED → RETRIEVING → ✓ PULLED during a pull, wherever the pull was started.

  The cohort also carries STUDY beside MRN, so gathering a study leaves the operator able to tell which one they took, and its frame gains REMOVE, which takes every member out — a row's REMOVE takes one, and emptying a cohort one row at a time is not a gesture anyone wants.

- 5b520c7: An index says what it counts.

  `@2` said nothing about what it counted — in a PACS answer every study read "1", being the only study under its patient — so a bare number is no longer an index. A handle names its KIND and its place in that kind's sequence: `@SER3`, `@STD001`, `@FIL2,3,7`, `@DIR2-4`. One sequence per kind runs across the whole answer, so a handle is a name rather than a position and a sorted listing does not renumber it; zero padding is how the pill draws it, not something to type.

  What a row hands over differs by kind. A series, a file or a folder hands over its path; a STUDY hands over its series — what the surface's GATHER on a study hands over — so `gather add @STD001` and `pull @STD001` act on the whole study from a console exactly as a press does. A verb refuses a kind it does not take, by name and at expansion: `image @STD001` says "image takes a series or a folder or a file; STD001 is a study" instead of resolving to a path and failing three steps later for a reason that names nothing typed.

  On the surface the pill draws the handle, lit in the pane's frame hue on the rows the session reaches, and a study row wears `STD001` where it read a meaningless "1". The `numbered` message carries each row's kind, place and address, so a pane finds its rows by address and draws the code the operator would type.

- 3c6a0d3: ARGUS and kernel: the gather gesture is reachable, and an exported table is visible where it landed.

  Three faults found by running the operator's own flow against a live PACS.

  **GATHER SHOWN was invisible.** It was put on the results mode frame, which is the closed spine at rest: measured live, 22px wide and `visibility: hidden`. It now stands beside EXPORT CSV on the command row, where the verbs that act on the whole answer already live.

  **GATHER was offered only once a series was home**, so on a fresh answer, where nothing is home, the gesture did not exist. A cohort is a set of targets and the feed it roots is made by a pull over its members, so a series is gatherable once it can be named: a PACS path, or the fact that it has landed. Query, filter, take what matched, fetch it as a set. PULL still means bring this one now.

  **The export was not broken; the listing was stale.** The CSV writer wrote straight to CUBE and never invalidated the folder's cached listing, which every other fs verb does — so `cat` returned the file while `ls` and every browser showed the folder without it. The write now invalidates the folder it wrote into, and the one that shows a folder it had to create. The WROTE readout also opens that folder when pressed.

- 21f8d21: The door itself: the porter logs a browser in and argus leaves by the door it came in.

  porter: `GET /login` asks for a username and a password; `POST /login` (form or JSON) trades the password for a CUBE token, starts or joins the session, sets a signed HttpOnly SameSite=Lax cookie naming it (Secure behind TLS, a day long by default) and sends the browser to `/s/<key>/?door`. The cookie gates the boot stream, the mount and the wire: a browser reaches only the session its cookie names; without it, the door (302), a refusal (401) or a dropped upgrade. `POST /logout` clears the cookie and leaves the session running. `PORTER_SECRET` signs the cookie; given none, one is made up per start and said so.

  argus: a LOG OUT pill beside AUDIO and the theme, in the frame's hue, standing only on a page that came through a door; pressed, it tells the door to forget this browser and goes to the door's login. The session is not touched. Law: a-surface-leaves-by-the-door-it-came-in.

- 43b9440: The space of everything run here: the wait is drawn with what is known, and UNIVERSE is a face.

  While the job index warms, RUNS-02 had nothing to show but a refusal and a moving figure. Now the session reports each feed as the index reads it — its jobs collapsed by plugin per place in its pipeline (a fan of three hundred conversions is one node of 300), with a status on every node — on the prompt context (`procWarmup.landed`), and the pane draws them as they arrive: every feed its own small DAG, floating free like molecules in a solution, counts as weight and status as hue, feeds of one pipeline shape pulled together by an unseen anchor so the space settles into constellations. Every node is real. When the index is whole the roster takes over, as before.

  `proc universe` answers the same picture from the cache at any time, whole or warming, and says which; the dashboard's UNIVERSE tile opens it on the RUNS canvas. A feed's status words are now the DAG's own (`finishedWithError`, `started`, …) wherever cumin derives them from counts, so a feed on a surface wears the hue its jobs would.

### Patch Changes

- f94480e: ARGUS: the PACS field fills its pane.

  A PACS answer stopped a third of the way down a full-height pane, rows cut mid-line and black beneath: `.pacs-listing` was capped at `34vh` — a cap on the viewport, from the day the PACS workspace stood in the header row above a console and had to leave it room. As a body tile the cap outlived its reason. The field now takes whatever its pane leaves it and scrolls within that, as every other tabular pane's field already did.

- 2322151: argus: a refused roster keeps its words and loses its count. While the job index warmed, RUNS-02 showed the daemon's refusal with the count frozen at the instant of refusal — `(300/210012, 0%)` — beside a live figure that moved; the frozen number read as the truth. The refusal now carries only its reason; the live line beneath it is the one figure.
- d1a1c0d: argus: a file comes down as a download. DOWNLOAD on a file row saved nothing a browser could show — it opened the bytes in a new tab. It now presses the daemon's attachment URL through the browser's own save gesture, and stands beside CLOSE on a text file's and an image's header too.
- fa26e17: ARGUS: a listing opens the frame of the pane it is in, not the one it was built in.

  Indicating a row inside a node dive lit the row and put its verbs in the zone, but the mode frame never opened, so the verbs stood behind a closed frame. The listing resolved its pane once, at construction, and the node overlay builds its browser before appending it to the scene — so that listing's pane was null and stayed null, and the attribute that opens the frame was never written.

  The façade now asks the document for the pane each time it needs one, and installs its frame watcher on the first paint that finds one rather than at construction. A unit test builds a listing detached, attaches it, and requires the frame to open.

  The same stale answer had also left the MKDIR smoke scenario typing into the console after that question moved to the pane; it now answers on the bar.

- 77c73aa: ARGUS: a frame opens outside a pane, and every cohort member offers PROCESS.

  Clicking a row in the cohort selected it and left the frame shut. The façade opens a frame by writing `data-modes` on the pane the zone stands in, and the cohort's listing rides the header band, which is not a pane — so the zone filled with the row's verbs behind a frame nothing had told to open. A frame's host is now whatever declares itself one, with a pane the common case rather than the only one.

  The cohort's verbs also follow the rule the operator set. Every member offers PROCESS, refusing by name on one not yet in CUBE and saying to PULL first; PULL stands on the members that are not home; and the frame, which belongs to the whole listing, carries the cohort's PULL, REMOVE and PROCESS.

- cd7714d: ARGUS: the console's lid breathes at its end block only.

  With the console closed, the left end of its lid pulsed against the gutter's elbow, and the gutter seemed to echo it. The rule that makes every pressable block breathe had been applied to `#drawer-toggle`, which is the whole bar row at full width, so a brightness filter swept across a bar that joins a static frame member — the very thing the lid's own rule warns against. The whole-row breath is gone; the lid's pulse is `lid-beckon` on its end block, as designed.

- b748002: ARGUS: a projection offers only the verbs that can act on it.

  `/proc` and `/net` are the kernel's renderings of things that are not folders, and nothing writes them. A listing there was still offering MKDIR and UPLOAD on the frame and MOVE, COPY, DELETE and SHARE on its rows — verbs with nothing behind them to act on.

  They stand down in a projection. What a projection is for stays: a file offers DOWNLOAD, a series folder IMAGE, and a node's own data offers PROCESS. A row left with no verbs keeps its single click, so `..` still walks and a child job still hops.

  The feed a path names is also read from either address now, the stored one or the projected one. A node reached through `/proc` was being offered a new feed rather than the one it is already in.

- a8e0f87: ARGUS: a pull is not a gather.

  Pulling a series put it in the cohort. That was the PACS pane's founding model — pull as the selection gesture, when the gather was the pane's own tray — and it outlived its reason once the cohort became the session's. PULL means bring it home; GATHER means I chose this. Series PULL and PULL STUDY now queue their badges and touch the cohort not at all; the cohort is built only by GATHER.

- dc369d3: ARGUS: a verb acts while a question stands, and the export path is the whole answer.

  The console refused to dispatch any line while it was busy, and a command that asks a question stays busy until it is answered. So every verb that lowers to a visible line queued behind an unanswered question — including the errand bar's own MKDIR, whose question was what blocked it, and the browser's MKDIR, which read as dead while its listing kept refreshing on the silent channel. A question occupies the prompt, not the session: a verb the operator pressed now goes around it, echoed as always.

  The errand bar's MKDIR is gone. It made the folder the path lives in, so a field holding a directory made its parent, which already existed, and the browser walked up a level for nothing. The typed path is the whole answer: the command that asked makes the holding folder, says which one it made, and refuses by name when it cannot. A browser's own frame still carries MKDIR for making a place before choosing it.

  The WROTE readout no longer carries the kernel's colour reset into its text.

- d3a8335: ARGUS: a question a pressed verb provoked stands on the pane that was pressed, and a CSV listing has a frame.

  DELETE lowers to `rm -i`, which asks before it removes — and that question went to the console, while MKDIR's stood on the pane. The line was drawn too cleanly: a session question does belong in the console, except when a pressed verb provoked it, because the operator is looking at the row they just acted on. A verb that lowers to a command now says which pane pressed it, and the question stands there with YES / NO / ABANDON. The transcript still keeps the exchange.

  The CSV table view also had no frame to open. Two rules reached past their own pane: the content view hid `.mode-frame` by descendant, so a view bringing its own field had that hidden too, and the field variables were declared on a fixed list of containers the new field was not on. Both scoped properly; the table's spine now opens like every other field's.

- 4ce1ddc: argus: a table's frame is its own. A CSV on stage drew its rule, strip, elbow and frame against the pane rather than its field — the spine climbed into the path header over CLOSE — because the field inherited the pane body's `--mode-frame-top`; the field now owns its frame's top. And the frame carries the table's verbs, FILTER, RAW and CLOSE, as blocks; the header keeps the path and the state.
- 9339853: ARGUS: CLEAR asks before it throws a cohort away.

  Once cleared, a cohort is gone. So CLEAR on a cohort that has changed since it was last SAVEd asks on the band — "Save the cohort first?" — YES saves and then clears, NO clears, Esc leaves everything standing; a name abandoned inside the save abandons the clear too. A cohort already saved clears without a word. The session's working file is not a save; a cohort never named is unsaved.

- acbade9: ARGUS: CLEAR is a verb, and a dismissed header leaves whole.

  The cohort frame's whole-cohort block read REMOVE N — the same word as the per-row REMOVE — so it did not read as the thing that empties, and the operator looked for a CLEAR that seemed not to exist. It is CLEAR N now, the kernel's own word, and it lowers to a visible `gather clear`. DISMISS sends the band's face away and forgets nothing; its comments no longer claim otherwise.

  Sending the header away left ghosts — an elbow, a bar, a clipped title — because it slid by its last rested height, and a face that had just grown the band was taller than that. It glides by its own box now.

- 9c5a7c2: ARGUS: the cohort's face takes the whole band, and a cohort row offers the fetch.

  The band's faces are flex items in a row that packs to the right, which suits a block of readouts and stranded the cohort's listing in the last third of the screen with its columns crushed. A listing takes the field it is given.

  The cohort's rows were also written when a cohort held only series already home: REMOVE always, IMAGE and PROCESS once CUBE named the folder, and nothing at all for a member that had not been fetched — while the frame above them pulled the whole set. A member that is not home now carries PULL on its own row, lowering to the one line the operator could have typed.

- 1c169d7: The greeter: the door answers at once, and a boot is watched rather than waited for.

  porter: `POST /login` no longer holds the browser for a cold boot. A session already up is entered directly; one that must boot sends the browser to `/greet/<key>`, where the mise brain wakes — the same frames a terminal boot draws, paced by the page — and the daemon's boot rows arrive beneath it as they are written, ANSI and all, from the boot stream. `ready` rests the brain and hands the browser to the session; `failed` says why and offers the door again. The login page wears the same shell with the brain at rest. The porter serves the two modules it draws with from the installed wire package (`/greeter/brain.js`, `/greeter/ansi.js`); a booting identity is pending in the registry and reaches its mount only when its berth answers.

  menu: `@fnndsc/menu/ansi` — the ANSI-to-HTML converter and the console palette, moved from the ARGUS console so a browser greeter renders a boot the way the console renders a transcript; argus keeps the DOM half and re-exports the rest.

- d78447d: ARGUS: the cohort's block joins the header column instead of being appended to it.

  The last block of that column carries the frame's elbow, and its ground runs on into the frame sweeping away beneath it. Appending the cohort's block after it cut the corner off that shape and left the new block wearing a radius that belongs to the frame.

  It sits between the nameplate and 02-CALYPSO now, takes the light seat between the two dark ones since it is its own thing, and carries the ordinary rule beneath it. 02-CALYPSO keeps the corner it always had. The block also reads its own state from the first frame, dim while the cohort is empty rather than lit and promising something it does not hold.

- 38fbdb9: ARGUS: `..` navigates and nothing else.

  The parent row was offered a directory's verbs, computed for the place on stage while standing on a row that names the parent — so MKDIR reached from `..` said "make a directory in this listing" from a row meaning "up". It is offered nothing now, and the façade's own rule does the rest: a row with no verbs to hide keeps its single click, which is what going up should cost.

  The field's verbs were never `..`'s to lend. MKDIR, UPLOAD and REFRESH ride the frame, which is what answers to the field.

- Updated dependencies [8a8dc25]
- Updated dependencies [1bdf876]
- Updated dependencies [5b520c7]
- Updated dependencies [7bba167]
- Updated dependencies [1c169d7]
- Updated dependencies [43b9440]
  - @fnndsc/menu@0.10.0

## 0.10.0

### Minor Changes

- cd6a0ab: ARGUS: a DAG node offers PROCESS, on the overlay that describes it.

  Indicating a node shows its facts — plugin, instance, status, wall, size, data, and the lifecycle strip. It offered nothing to do about the node, so appending a run to a feed had to be reached through a browser even while the graph was on screen.

  The overlay now carries a PROCESS pill. It opens the bound catalogue on the node's own data, joined to the graph's group, so a run appends to that node; the binding reads `INPUT … → feed N · node M` as it does from anywhere else. The verb keeps the name it has on a directory, a PACS series and a cohort, since one act with two names costs a concept.

  A collapsed ×N group withholds the verb and says why: an aggregate has no single instance for a run to append to.

- fa90f05: ARGUS: a question the surface asks stands on the pane that asked it.

  Every question the surface put went to the console, and a console can be closed. PROCESS on a gathered cohort asked for a name into a drawer of zero height: the press read as dead, the surface sat waiting on a question nobody could see, and a second press was refused because one was already open. SAVE and EXPORT CSV did the same.

  A surface question now opens on the pane that provoked it, as a bar across its head — the question stated, the value editable and holding the keyboard, one committing verb reading what it will do (NAME IT, RUN, MAKE IT), ABANDON beside it, a yes/no as two capsules, and Esc abandoning wherever the hands are. The console still records the exchange, so the scrollback remains the whole story of the session. A question the session puts still belongs in the console, which now exposes itself to carry one.

  The GATHER pane also indicates its cohort row on arrival: a listing of one row has nothing to choose between, and its verbs should not have to be hunted for behind the fold capsule.

  Law `a-question-stands-where-it-was-asked` (AEGIS), enforced by the smoke suite with the console deliberately closed.

- de5508d: ARGUS: `attach` says how to reach this session from a terminal or another browser.

  An operator working in the browser who wants a terminal on the same session needs the daemon's URL, port and attach token. The surface already holds all three, since the page reached the daemon by an address carrying the token, so the console now answers for them. `attach` prints the session identity, `chell --remote` for a terminal on the same machine, `chell --remote --attach "<url>"` for one anywhere else, and the browser URL for a second browser. Nothing is asked of the session.

  The token is a bearer credential with no expiry, so the readout masks it and only `attach --reveal` prints it. An address on loopback says so, because a second machine cannot reach 127.0.0.1 whatever the token says. Law `a-surface-says-how-to-reach-it` (AEGIS), enforced by the smoke suite in both directions: the masked form never carries the token, the revealed one does.

### Patch Changes

- 6c6ca51: ARGUS: the PACS query form's fields are black again, not the browser's white.

  Every field of the query form (PATIENT, MRN, DATE, ACCESSION, MODALITY) was drawn as a white box with the frame's own light type on it, which is unreadable. The fields shared one selector list with the gather tray's name field, and removing the tray took the list's second half and the declaration block with it, leaving a dangling `#pacs-form input,` that fused onto the rule below. The fields then had no background, no border and no colour of their own, so they fell back to the browser's defaults; they also picked up that rule's `display: flex` and bottom margin.

  The block is restored: black ground, lit border, mono type, and the focus ring the command line beneath them has.

- ee75252: ARGUS: the listing inside a node behaves like every other listing.

  Diving into a DAG node overlays a browser on the node's data. That browser declared no row verbs, and a listing with nothing to hide behind an indication keeps its old bargain of activating on a single click — so alone among the surface's listings, a click there walked into the row instead of indicating it, and the mode frame never opened.

  It now declares the same verbs as any browser, computed by the same roster: a click indicates and writes the regard, a double click goes, and a node's own `data` is offered PROCESS inside the graph exactly as it is outside it.

- 934d2d3: ARGUS: a node's lifecycle stops say their names, and move while the node does.

  The strip under a node's facts was six bare dots with the stage name in a tooltip, so it could only be read by someone who already knew the lifecycle — and the one moment it earns its place is a node in flight. Every stop now carries its name, the stop the node stands at is drawn larger as well as lit, and stages the line has not reached stay dim.

  The overlay is also repainted whenever a fresh model arrives, from the feed watch the pane already holds or from a REFRESH. Before this the facts were a snapshot taken when the node was indicated, so a node that moved on kept showing the stage it was at when it was clicked.

## 0.9.0

### Minor Changes

- 3c9af17: A row's verbs live in the frame, not on the row. The files browser no longer reserves an action track on every row: indicating a file draws its verbs (DOWNLOAD, MOVE, COPY, DELETE) in the mode frame's row zone, one beneath another under the field's own blocks, and the frame slides in as they arrive; the row becomes a segment of the frame, its block colour with black type, run out to the spine; a touch on the field or Esc retracts the frame and stands the row down. The selection's verbs ride the same zone, replacing the selection bar. A row offered no verbs keeps its single click, so a directory is entered with one click again and a DICOM series folder keeps IMAGE. The façade's `rowZone` is opt-in per listing; the runs roster and PACS are unchanged.
- f549b09: PANES is now a desktop switcher: a card is a whole ARRANGEMENT, not a single image. Restoring a card brings back the domain and its tiles as they were — a PACS query beside its viewer, not the viewer beside a stray files browser. A desktop is captured as a REPLAY of console actions (`view pacs`, `pacs query …`, `image <path>`, `image layout mpr`, `image tags`) at a single `domain_enter` chokepoint every gutter domain routes through, before the preset switches, so no context is lost. Replaying rebuilds the arrangement because each `image <path>` splits itself beside its domain exactly as it did live. Cards are keyed by the on-stage viewer's series (deduped — returning updates the one card); this unifies with the existing `desktop` feature (a card is a desktop; `desktop save <name>` pins one). The narrow-PACS clip is fixed in rendering — the workspace scrolls both axes rather than clip a verb — and replay inherits it.
- d3e5494: The frame takes PACS, the browser's place has a row, and a verb lights where it now lives. PACS rows carry no verbs: a study click folds it and puts PULL STUDY in the mode frame's row zone, a series click puts GATHER / IMAGE / DIR / PULL there, and those light in the frame as the cohort and the stage change. The browser lists the place's own `.` row after `..`, offered NEW DIR / REFRESH / DELETE (and the feed's SHARE inside a feed). The indication now belongs to the field like the selection: a fold, a sort or a re-listing of the same field keeps the indicated row lit, and only navigation clears it.

### Patch Changes

- 0d99ec5: PROCESS on a cohort: the cohort's feed is made first when there is none (`pull --new-feed`, the name asked once), then a catalogue opens bound to the feed's root so a run appends to the cohort. The cohort row lights `FEED N`, which opens the feed's graph; CREATE FEED is withdrawn once the cohort has a feed; the feed travels with the desktop.
- a38bb64: A control in a row is a capsule that reads what it will do next, and the browser speaks the console's vocabulary. Every listing row keeps navigating apart from selecting: a control cell activates the row (OPEN / CLOSE folds a PACS study, OPEN enters a directory or shows a file, UP on the browser's updir) and nothing else, while the row's body selects it and puts its verbs in the frame — so a directory can now be moved, copied, removed or its feed shared without entering it; the browser's `.` row is gone and REFRESH rides the frame. The browser's rows carry the console's Nerd Font icons and the console's colour per kind, read from tokens the console publishes and held equal to the console's own table by a test.
- ab127ea: A catalogue is a desktop: leaving it for another domain and returning from PANES brings it back bound to the same input, its run strip's line verbatim and RUN ready, with the graph of a run opened beside it in the same split. The catalogue leads with RECENT, the operator's lately-run executables from the kernel's instance listing, newest first.
- 0d5f0d7: A runs layout with a graph on stage is a desktop. Leaving RUNS-02 with a feed open now leaves a card in PANES-06 that brings the graph back in the view the operator had chosen (layout, projection, scale, hue, census); before, only a second pane beside it earned a card, and even that card returned to the roster.
- 3c6555a: A pane header keeps its title on one line: a long name ellipsises (the whole of it on the tooltip) instead of wrapping inside the fixed-height bar, where it cut the letters and pushed the mode and state readouts onto a second row.
- 7c2308b: Pressing a PACS series-row verb jogged the whole row sideways and moved the capsule. Gathering a series grows the cohort tray, which shares the pane's height with the listing, so the listing lost height, its field gained or lost a scrollbar, and every row and verb shifted by the scrollbar's width. Now the PACS workspace reserves the scrollbar gutter whether or not it shows (`scrollbar-gutter: stable`), the cohort tray scrolls within a bounded height instead of stealing the listing's, and a pressed capsule reads as a press in place — it darkens to a deep hue, changing only its fill, never a dimension that would reflow the row.
- a4a38b1: A volume a run produced opens from the node that made it. The dive inside a graph knew only raster images and read everything else as text, so a NIfTI in a node's `data` answered READ REFUSED; it now asks the same rule the browser does and opens an image pane beside the graph.
- 566be78: A session begins at the DASHBOARD: one block per domain, each carrying what it holds now and ending in the verb that opens it, with rows that are doors into recent work. It is the empty state rather than a menu in front of the app — content opening takes the stage back to home, DASHBOARD-01, the gutter's first block (an inert SOURCES block until now) and the word `dashboard` return, and a capsule on the screen says whether a session starts there. A browser that has never chosen begins here once.
- 62ef29b: The frame's elbow no longer hangs in the corner when the gutter it joins has left. A zoom (and the operator's own dismissal of the gutter) slides the gutter off stage, leaving the join's fillet painted as a dark hook over the pane that begins there; the fillet now goes with the member it joins to.
- f6d818b: The DIR verb widened a PACS series row to three capsules (GATHER, IMAGE, DIR) where the action track was sized for two, so DIR clipped at the pane edge. The series action track grows from 12em to 16em, which the three capsules clear with room. Fixed track, so every series row reserves the same width and the caps stay aligned.
- 97596db: PANES-06 only stored desktops that contained a viewer: a layout of file browsers, or a runs layout, left nothing behind, because capture keyed the card on an anchor taken from the first image tile and skipped when there was none. A desktop is any arrangement with content beyond the bare domain now (a single primary pane is still not carded — it is one gutter press away). A viewer desktop stays keyed by its series; a viewer-less one is keyed by the set of content it holds, labelled by its folder or `FILES · N panes`. Verified live: a two-browser files layout leaves a card that restores both browsers.
- 15b8875: GATHER is a listing pane. Gathering the first series opens a GATHER pane below the PACS results, joined to the workspace: the cohort row over its series rows, the cohort's SAVE / EXPORT CSV / CREATE FEED / DISMISS and a series' REMOVE / IMAGE / PROCESS in the frame's row zone. The tray under the results, with its checkboxes, is gone; membership is the row. The cohort is named at its first SAVE and travels with the desktop.
- aef1a8d: The left body gutter now dismisses the way the header does. A press on the domain already shown (FILES while in files, PACS while in pacs) slides the gutter off stage left and hands its width to the workspace — a focus of the whole field, distinct from a single-pane zoom. A press that navigates still lands deterministically in that domain (the gutter law holds); only a press on the current domain carries the dismissal. The state (`data-gutter='away'`) is orthogonal to the header and to zoom, so header-away, gutter-away, or both (a full-bleed wall of panes) compose, each restored from its own edge. A pulsing left strip or Esc restores the gutter; Esc peels one layer per press — zoom, then gutter, then header. Not persisted across a reload.
- 35064c8: With the header dismissed and the console closed, both panes lost their top load-carrying frames off the top of the page. Header-away reclaimed the header's space with a negative margin sized to the header's height; in the flex column that pull amplified (a -368px margin dragged the workspace ~500px) and, with the console closed so the workspace already sat near the top, overshot past the top edge and carried the pane frames with it. The header now leaves the flow when dismissed — taken absolute and glided off the top by its own height — so the workspace flows up to fill the top exactly, console open or closed. Same family as the zoomed-pane-frame fix, one layer out.
- 59a3f96: A file browser opened in a narrow split, resolving a long CFS path, could shove the whole body to the right — the viewer's frame off the edge, the header notch out of line. Three boxes carried `min-height: 0` but not `min-width: 0` (`.files-panel`, `#pacs-workspace`, and the sticky `.files-path` breadcrumb), so a wide child (a CFS path is a long, mostly unbreakable token) could set a min-content floor wider than the pane and push the row. Each now carries `min-width: 0`, and the breadcrumb wraps within the pane rather than establishing a floor. A pane's content scrolls or wraps inside the pane; it never resizes the layout.
- 4aaad51: PANES-06 came up empty after navigating between domains. The gutter's original domains (files, dag, pacs) are primaries the orphan sweep spares so a domain switch never disposes them; PANES was added as a domain but omitted from that list, so moving to RUNS or FILES disposed the PANES pane itself and the card grid was gone on return. PANES now joins the spared primaries. A smoke scenario guards it: move away to RUNS, open PANES, assert the group is a card and restores on press.
- 480632d: PROCESS. A directory selected in its parent, a node's data inside a feed, a DAG node, a PACS series or wholly-home study now offer PROCESS, which opens `/bin` as a catalogue bound to that place beside the pane and joined to its group. A plugin row's RUN composes the line the console would take (a `cd` to the input, the executable, a new feed's title asked once), runs it, and lights a FEED capsule that opens the run's graph beside the catalogue.
- 10b99d2: Desktop restore replayed its action log one pane at a time and waited for each viewer's series to finish loading before opening the next — a whole desktop took as many seconds as its viewers' loads laid end to end. Replay is structure-first now: each open hands back its pane id synchronously (a new `onOpen` on `image_open`), the whole arrangement is built in one pass, and the slow parts (a series' header read, a query) load in parallel behind the frames. The `wait_until` polling and fixed `sleep`s are gone; saved view state lands on the viewer's own completion; the domain switch calls `domain_enter` directly (synchronous) so its orphan sweep can't dispose the panes opened after it. A viewer-plus-browser desktop's frames now return in ~90-250 ms (were seconds), geometry unchanged. This is also the substrate the shared-session collaboration layer needs.
- 66ecf22: A zoomed console sits inside the viewport. Its height was a constant measured from the screen while it still began below the header's gap, so it ran past the foot: the workspace showed under it in a band and the page outgrew the viewport, which could carry the console's own top frame above the fold. The workspace now steps off stage for the zoom and the console takes what is left of the column.
- 2d52827: The contrast audit is a gate: the smoke suite now measures the frame's type against WCAG 2.1 AA on the live surface in all five schemes, compositing every translucent layer between the type and its ground. It found three defects the written audit had missed — the STALE readout at 1.38:1, the SIZE cap at 4.42:1, and PHAROS keeping the navy MEDICAL was lightened away from — and all three are fixed.
- 5d4bb4d: The browser's row control is the kind's glyph: the console's folder, file or cog in a capsule of its console colour when the row opens, bare when it opens nothing. The words OPEN and UP are gone from file listings, and `..` is a directory row wearing the folder with its name shown. PACS keeps OPEN / CLOSE on its folds.
- 6d8a595: The graph is the form. In a catalogue bound to an input, opening a plugin dives straight into its one node, and the dive's parameters are VALUE cells writing their flags into the run strip's line as typed (booleans bare, a hand edit standing). RUN rides the graph's frame. A pipeline node dives as `title · @id` editing `--<node>.<param>`; off a node it is refused by name, since the kernel runs a pipeline only on one.
- 3f45362: The feed roster settles itself. It asked a flex-laid-out element whether it was `block`, so it never re-asked the session: a finished run read RUNNING forever, a cwd inside a feed painted its graph over the roster, and an arriving feed that was not listed prompted no look. The roster now holds its own shown state and re-asks every ten seconds while a listed feed is live, falling back to a minute once every row is terminal.
- b329170: The runs roster's verbs live in the frame too: a row's OPEN enters the feed, its body selects it and puts SHARE / DELETE and the grant readout in the roster's own frame, and the in-row track is gone. The listing façade now mints the row zone itself into whatever mode frame frames a listing's field, so no pane declares one and no template carries a span for it.
- 3f96d86: The pipeline cycler's seed `ls /bin` at boot is no longer observed by the panes, and the surface lists the session's working directory once on attach, so a browser following the session opens where the session is rather than in `/bin`.
- 2080342: A PACS series row's verbs now carry a persistent lit hue when their result is on this surface's stage: IMAGE lit when a viewer regarding the series is open, DIR when a browser on its folder is, GATHER when the series is in the cohort (PULL stays plain). The state is derived from the live panes (kind + regard address), recomputed on every stage change and toggled on the rendered rows in place, so the listing never re-renders. Because it is derived it is honest across a close and free on restore — the replayed intents recreate the panes, the bus reflects them, the verbs light — so scrolling the series list after a restore traces what was visualised and DIRed. One engaged hue reads across the pills (the deep fill #579 gave a press, now also the persistent selected state), clearing WCAG AA. Scoped to the local surface.
- 7126bca: Dismissing the page header expands the body to fill — but zooming a pane while the header was already away slid the pane up twice (the header-away slide and the zoom slide both applied), carrying its top frame and controls off the top of the page. Zoom now owns the presentation: it sets the away state aside for the duration and restores it on unzoom, so a zoom from away runs the same geometry as a zoom from a shown header. The slide distance is read from the header's last rested height, since clearing the away state leaves the header mid-slide and unmeasurable.

## 0.8.0

### Minor Changes

- 7ca8d04: The image field keeps its shape, the probe reads live, a stack fills before it turns, and the overlay counts. Opening the mode frame narrowed the field and the canvas was stretched by CSS into it, squeezing the image and stranding every measurement; the engine now resizes with the field and keeps its camera, so the pixels keep their shape and the annotations stay on the anatomy. PROBE was the library's ring-and-nothing; it is now a live readout at the foot of the field of position, slice and value under the pointer, leaving nothing behind. A stack no longer scrolls in pieces: after the first slice the rest are counted in (`LOADING n OF m` on the bar, `READING SLICES n / m · nn%` on the field) and the wheel is honoured only once the stack is whole; over the 256 MB guard the first slice shows, the bar reads `SERIES <size> · LOAD FOR STACK`, and LOAD fetches the rest. The header overlay leads with `SLICE n OF m` and follows the wheel.
- 67f5fd5: A link group that leaves the stage is now dormant, not destroyed. A gutter domain switch disposed every non-primary pane permanently, which is the "lost panes" defect — nothing to return to. The orphan sweep now first snapshots each leaving group into a dormant set (`app/dormant.ts`): the series or volume it regarded (its stable id), the image view state (layout, slice, window/level, colormap, ghost — now exposed through `state_get`), the member kinds, and a viewer thumbnail. The set is LRU-capped (24), forgotten only by an explicit dismiss, and persisted to the surface's localStorage, rehydrated dormant on reload. No visible surface yet; the PANES-06 domain that shows and restores these follows in the next slice.
- 9cf2ea2: `image <path>`'s text reflection now carries a thumbnail of the middle slice, so a TTY sharing the session shows the picture, not only the facts. The kernel reads the slice's pixels (`dicomSlice_gray` in salsa, uncompressed transfer syntaxes via dcmjs), window/levels to 8-bit with MONOCHROME1 inverted, and box-downsamples to a cell grid; brasa renders it as an ASCII ramp on any pipe or ANSI truecolour half-blocks (`▀`) on a colour terminal. Colour is a new declared surface capability: ARGUS declares it (its DOM console renders ANSI), chell reads its own terminal through chalk, a bare pipe gets the ramp. Compressed pixels say so in one line rather than pulling a codec into the kernel; an unreadable slice leaves the facts and no picture. The ASCII ramp is always the floor.
- d133ef6: `image <path>` is a kernel command, not a surface verb. A new brasa builtin resolves what a path is — a DICOM series folder, a study, a `.dcm`, or a NIfTI/MGZ volume — and emits a typed `image.view` intent (schema and `IMAGE_MODEL_KINDS` in `@fnndsc/menu`) that every surface renders in its own way: ARGUS opens a rendered pane from the intent, a TTY prints the reflection the command renders (for a series, the same facts `dcm series` shows). So the same `image ~/uploads/sag-anon` works from a browser and from a terminal sharing one CALYPSO session. The surface keeps only the subverbs that drive a pane already on the field (`image layout|slice|wl|colormap|save|tags|load|guard|ghost`), declared shared so `image <path>`, `image --help`, and `image` alone fall through to the session; help lives in the kernel's registry. Opening an image no longer drifts into a surface-only verb.
- c70e11e: A landed series says where it was filed, and the image pane answers the press at once. A retrieve is confirmed by count and filed by CUBE a beat later, so the pull's "done" never knew the folder and a surface offering IMAGE on the row waited for the next query. The progress message now carries an optional `path`, `pull` resolves each landed series' folder before its channel closes and says it on the same channel, and the ARGUS PACS row takes the folder from the landing: IMAGE appears the moment the pull says the series is home. In the same breath, `image <path>` puts the pane on stage before the kernel is asked, with `OPENING <name>` on the field and on the bar, so a header read that takes seconds is never seconds of nothing; what could not open is named on the field, and counted loads say their percentage beside the count.
- aa486c5: DIR: a PACS series row can open the series' own CFS folder as a file browser, beside GATHER / IMAGE / PULL and under the same gate as IMAGE (`inCube && folderKnown`) — DIR and IMAGE are two faces of a landed series, one drawn and one listed. The browser opens joined to the series' group: a viewer already on stage for the series lends its group, so viewer and browser are one restorable group; otherwise the browser anchors the group on the folder. A browser already showing the folder is reused. Completes pane-group restoration.
- a29635a: PANES-06: the groups you moved away from, as cards to bring back. The inert COMPUTE-06 gutter slot is now a full-workspace domain that draws the dormant set as a grid of cards — one per group, with the viewer's thumbnail, a label from the anchor, and a badge per member. Pressing a card restores the whole group onto the stage at its saved view state (layout, slice, window/level, colormap, ghost) and reopens its tags member; the small DISMISS forgets it. Opening PANES sends the current group dormant (free and recoverable — it becomes a card too). It is a domain, not a floating overlay, keeping the gutter's one interaction grammar. This is the visible face of pane-group restoration; the scrollback-replay interaction on reattach remains to be reconciled.
- 5ed1785: A new SLAB layout: a crisp acquisition slice sweeping through a ghost of the volume. The slice is the real DICOM image at its true depth, windowed by the pane's W/L; the rest is a faint volume render (`image ghost <0..1>|off`). The wheel sweeps the slice, left-drag rotates, the bar reads `SLAB · z n / m`. It is the one layout that drives its own vtk render window rather than a Cornerstone viewport, because a vtkImageSlice composited into a Cornerstone VOLUME_3D viewport crashes that viewport's z-buffer pass in the pane while the same actors compose fine in a plain vtk renderer. DICOM series only for now; a niivue path for NIfTI/MGZ comes later.

### Patch Changes

- 7892529: The 3D layout renders when reached from MPR, not only when reached from a single stack. The volume is cached under the engine's id, so the MPR build loaded it there and a following 3D build got the already-loaded volume back with no streaming events to first render on — a black field, the operator's "select 3D, nada", seen only from MPR because a first 3D built the volume itself. The volume is now purged before each build so every layout renders as the first, and the 3D camera is framed explicitly rather than left to load events.
- a24d813: The look-fingerprint now sees what draws the frame. It read elements only, so every `::before` and `::after` was outside it — and the clean-room rebuild had dropped seven of them while both canons scored zero differences. Four more omissions named themselves the moment it was widened: the spur and the bite carried by the long block of each band are back. The record covers each element and both its pseudo-elements across 71 properties, including `content`, `background-image`, `clip-path`, `mask-image` and `filter`, with every animation stopped first so it measures the stylesheet and not the moment.
- de4dac8: The console input is regular weight, not bold — it smeared at that size and read as out of focus. And the voice can be the original TheLCARS.com beeps again: `scripts/sounds_import.mjs` materializes them from the operator's own LCARS-26.zip into `public/sounds/` (gitignored, because the template's EULA forbids redistribution), and each sound prefers the original `.mp3` with the committed synthesised `.wav` as the fallback, so a clone without the zip still has a voice. Sounds moved to `public/` so the browser can fall from one source to the next.
- 26eaf6a: Every colour pairing that carries type now clears WCAG 2.1 AA, in all five schemes. Three defects: the clinical navy carried black 22px type at 2.35:1 where the bar is 3:1, and it is the default scheme; the inert gutter blocks faded ground and label together and reached 1.36:1, so they now invert instead of fading; and the about-face telemetry caps, small enough to be held to 4.5:1, invert under the clinical schemes only. Measured per theme in `docs/WCAG-AA.adoc`.
- b6d0264: The gutter's elbow is a cut corner again. FILES-01 sweeps its top-left away over a coloured gutter, and the black mask that made the sweep read as a corner rather than as an arc painted on a rectangle was lost when the frame was rebuilt clean-room. The mask is back, sized to the radius it hides rather than to a fixed height, and both the corner and the mask now take the same `--elbow-radius`. PHAROS cuts no corner and so declares no mask.
- 7b5a7b9: The elbow's inner half is back in both panes. The bar met the gutter in a hard T where the frame had always turned: the clean-room rebuild kept the gutter block's swept outer corner and dropped the fillet that turns the bar into it. It is two pseudo-elements in one square — a hard-split diagonal laying the colour, a square of page over it with one corner rounded away — and with animations frozen the joint now matches the old frame pixel for pixel on every scheme.
- 6990c3a: LOWER DECKS has its palette again. It is the scheme selected by removing `data-theme`, so its seven colours have to sit on the bare root; they used to arrive with the imported stylesheet, and when that stopped shipping the scheme rendered black — every block drawn, every colour resolving to nothing. The seven are seated, which also restores the four state hues derived from them, and the four named schemes are unchanged to the property.
- b4689e2: A viewer opened from PACS is now its series' link group, not an anonymous loner. The PACS open path spawned the viewer with no host group, so the pane drawer could not reach it and a second IMAGE on the same series spawned a duplicate viewer. It now anchors the viewer's own group on the series it shows, so the group is that series' group: the drawer reaches it and a viewer already on stage for the same series is reused. A viewer opened from a pane that already has a group (a files row) is unchanged. Foundation for pane-group restoration.
- 0215547: PHAROS speaks in lower case. The imported look sets every label in caps; PHAROS sets its own in lower, the same move as swapping the face carried to the letters. The frame may re-case its own words, the session's words never: listing cells, console lines, typed fields, a pipeline's title and the footer's attribution all keep the case they arrived in. LCARS is untouched.
- bf4c118: The RUNNING count clears when a pull ends, and the console echoes the query and retrieve a pane runs. A pull reported each series under `pull:<uid>` and closed the operation under `pull:` with no id, and a per-series retrieve ends in its `status`, not its `phase`, so "1 RUNNING" sat forever; the reconciler now clears an item on a terminal status and clears every key an operation owns when it completes or fails (pure, unit-tested; the same fix in the console cascade). And a query or retrieve fired from a pane button is echoed into the console as the command line it is — the transcript is the whole story of the session, not only of what was typed — then run silently so a long retrieve never locks the prompt; the incidental probes stay silent.
- 887c815: The join at every pane's top right is round at every phase of the breath, and the caps clear the elbow's fillet. The strip started at the frame's top beneath the elbow with a square corner and breathed while the elbow did not, so its corner showed past the elbow's 22px arc on every swing and merged into a square at unity; it now wears the elbow's radius. The elbow's 36px reach into the field is declared once as `--elbow-clear` and every roster grid keeps it clear on the right, so a caps row no longer loses its last cap's corner to the fillet. Both canons re-recorded.
- 8a4ddc8: The frame tools work on the layout they belong to. Zoom and pan did nothing in 3D and probe and measure did nothing on MPR, because the tool was never added to that layout's group and the button threw; every layout now declares which tools it offers, the panel dims and disables the rest, and the bindings passivate before they rebind (Cornerstone's setToolActive adds a mouse binding rather than moving it, which is why PAN lit and did nothing). In 3D, rotate, zoom and pan ride the three mouse buttons and the ZOOM/PAN blocks move one to the primary drag. In MPR the crosshair rests on the primary, a pointer tool takes it and clicking the lit block hands it back; the probe reads the volume the plane samples, and length and angle draw on a plane. Also lands the runningReconcile unit test dropped from the previous change by `git add -u`.
- Updated dependencies [9cf2ea2]
- Updated dependencies [d133ef6]
- Updated dependencies [c70e11e]
  - @fnndsc/menu@0.9.0

## 0.7.2

### Patch Changes

- 5ca4b39: Republished with its bundle. Both 0.7.0 and 0.7.1 went to npm carrying two files and no `dist/`, because both were published by hand from a checkout where the bundle had never been built — `dist/` is gitignored, so it exists only where someone has run the build. Neither the `files` field nor npm's ignore-file precedence was ever at fault. This release goes through CI, which builds before it publishes.

## 0.7.1

### Patch Changes

- 80127b4: The published package carries its bundle. `@fnndsc/argus@0.7.0` went to npm with two files and no `dist/`: with no `.npmignore`, npm falls back to `.gitignore` when deciding what a tarball carries, and this app's `.gitignore` lists `dist/` — the very thing the package exists to ship. An `.npmignore` now stops that fallback, so `files: ["dist"]` is the only thing deciding. The tarball goes from 2 files to 46, and a daemon that resolves the installed package finds an `index.html` to serve.

## 0.7.0

### Minor Changes

- c601a42: ARGUS is published, and a released install now serves it. `@fnndsc/argus` ships its built bundle, calypso depends on it, and the daemon's web-root search ends by resolving the installed package — so `npm install -g @fnndsc/chell` followed by `chell --daemon` prints a URL a browser can open, where before it printed only a WebSocket address. The unused `@fnndsc/calypso` dependency is dropped from argus, whose browser code imports only the wire contract.
- 3660509: ARGUS carries its own font and its own voice, and needs nothing downloaded. The typeface is Antonio, vendored under the SIL Open Font License — it is the Antonio Project's, and TheLCARS.com's template only ever carried a copy — and the four sounds are synthesised by `scripts/sounds_make.mjs` rather than borrowed. With the frame already written from ARGUS's own canon, nothing is left that the template supplied: `theme_ensure.mjs`, the gitignored theme directory and the build's materialization step are all gone, and there is no stand-in to degrade to. Both themes verified identical after every step. The attribution to TheLCARS.com stays.
- c0e92f7: ARGUS's page frame is its own. The shell, the left gutter, the bands, the right frame and the base element rules are now written in `argus.css` from `tests/smoke/canon/lcars.json` — the computed style of ARGUS's own rendered page — and TheLCARS.com's stylesheet is no longer imported. Nothing was transcribed from the template's source; the provenance is measurement of our own surface. The look is unchanged and provably so: identical across 275 elements and 55 properties under both LCARS and PHAROS, and identical again with the template's file emptied. The operator's own `LCARS-26.zip` still supplies the typeface, which the frame names and does without when it is absent.

## 0.6.4

### Patch Changes

- 1d29bf1: Clickable LCARS chrome breathes so it can be told apart from chrome that only decorates, and the closed spine — a control, at 8px a hairline that happened to be clickable — is twice as wide. The first pulse swung 16 percent and the operator could not see it: on a saturated block a small one-sided lift is no change worth noticing, so the swing now goes both ways from the resting colour, and the spine swings further still because area is what makes brightness readable. Reduced motion turns all of it off.

## 0.6.3

### Patch Changes

- d9e67a5: The image pane says what it is doing, and a dive that opens nothing no longer strands the diver. Loading a series or building a volume now draws a progress notice on the field itself, the field is cleared before the wait rather than after it, and each layout has its own lit control instead of one pill that cycled. An OVERLAY control writes the patient, record number, accession, series, date and age on the image, off by default. In the DAG pane, a dive whose overlay declines now flies the camera back out and says why, a ghost overlay record is dropped rather than believed, and Escape leaves a node from anywhere.
- Updated dependencies [4af65f4]
  - @fnndsc/calypso@0.13.2

## 0.6.2

### Patch Changes

- Updated dependencies [7c793ad]
- Updated dependencies [af2df66]
  - @fnndsc/menu@0.8.0
  - @fnndsc/calypso@0.13.1

## 0.6.1

### Patch Changes

- Updated dependencies [89d3287]
- Updated dependencies [9c320a0]
- Updated dependencies [d89e31b]
  - @fnndsc/calypso@0.12.0
  - @fnndsc/menu@0.7.0

## 0.6.0

### Minor Changes

- 49634f2: feat(argus): LANE, BEAT and CUBE rows on the ARGUS WEB face, and an ETA on every feed walk of the INDEX instrument
- 2545ffa: feat(argus): the RUNNING row on the ARGUS WEB face, whose ERRORED figure opens the runs roster filtered to the feeds with errored jobs — a readout that acts, and says so

### Patch Changes

- Updated dependencies [49634f2]
- Updated dependencies [49634f2]
- Updated dependencies [2545ffa]
- Updated dependencies [2545ffa]
  - @fnndsc/calypso@0.11.0
  - @fnndsc/menu@0.6.0

## 0.5.0

### Minor Changes

- 6cd5ab1: feat(argus): the DAG pane shows a cold feed's walk in place — INDEXING FEED n with the live count from the prompt, FAILED with REFRESH retrying — and opens the feed's watch on the pending answer so the graph lands without a re-ask
- 57ba039: feat(argus): the INDEX instrument — index movement read on the header's resting face: a quiet index reads CURRENT with what it holds, the global sweep rides that row with a bar, a feed's walk takes a row of its own with a bar that follows the count (FAILED where it stopped), arrivals a third, and a failed warm-up step keeps the row red with the steps named
- 98ab832: feat(argus): the status line reads ROSTER WALK / ROSTER DELTA and the INDEX instrument shows a ROSTER row while the roster syncs off the lane

### Patch Changes

- Updated dependencies [6cd5ab1]
- Updated dependencies [57ba039]
- Updated dependencies [98ab832]
  - @fnndsc/menu@0.5.0
  - @fnndsc/calypso@0.10.2

## 0.4.0

### Minor Changes

- 964a847: feat(argus): PHAROS, the house visual language, as a theme — the lighthouse, flat, on the medical colours; the imported look stays the default

  The theme pill gains PHAROS after the four imported schemes. Its shapes are drawn on the existing frame with `clip-path`, radius and one flat band, so no element's box moves: stone (flat colour, lit band, black joint), cut (a 45° facet on each gutter stone's outer corner and small on every cap, capsule and pill), inset (the focused pane's gutter stone tucks in from the outer edge, and swaps when focus moves), lens (the one curve, a Fresnel lens round a breathing lamp at the header stone's foot), flank (the outer silhouette rounded at its two corners behind a course-blue wall), course (bars ending in a point, square junctions, the gallery rail along the header). PHAROS wears the MEDICAL scheme's seven colours in this slice; the state hues derive from them as for every scheme. Chakra Petch and JetBrains Mono are vendored under the OFL. The layout now declares the focused pane on the body as `data-focus`. The root attribute is renamed `data-theme` (a remembered `argus-lcars` choice migrates), and the font names the stylesheet repeated twenty-seven times become two tokens a theme can swap. Defined in `docs/pharos.adoc`, a work in progress.

### Patch Changes

- 3bf392e: chore(argus): a component names no theme — `a-component-names-no-theme` fails CI when the listing façade's source or the component reference names LCARS. A component speaks its own vocabulary and takes its colour as tokens; the doctrine is where the theme is named.

## 0.3.0

### Minor Changes

- 22f300d: feat: the runs roster declares its listing (#428, S3)

  The runs roster is the second pane converted to the `Listing` façade. The order, the host, the chrome lookups, the filter block, the `argus:roster` parse, the action track, the indication model and the readout leave the pane; what remains is a declaration and `rows_set`, with two-line forwarders under the names the surface already calls.

  The roster takes the expanse rule as it converts: PROGRESS is the `1fr` expanse right after TITLE (now a fixed track), the trailing facts follow. The façade refuses a content-sized track at construction — `auto`, `minmax(0, …)`, the content keywords — since on a per-row grid such a track sizes per row and jogs every column after it. The roster's hand-typed `--roster-cols` leaves the stylesheet, with it the last place a cell count could disagree with the track list.

- 57c6815: feat: PACS declares its three levels into the listing façade (#428, S4)

  The last conversion. Patient over study over series is one declaration: a child declared beneath a child, each level with its own traits and tracks, its verbs on every row, one filter read down the levels, one sort naming its level. Three orders, a host, two expansion sets, two render methods and the state line leave the pane.

  The façade gained what the conversion needed: a group wrapping a row with the level it heads, a depth on every level, programmatic opening, a note for an answer with nothing in it, and a level's template for the form that stands on it. The last four hand-typed track lists leave the stylesheet, and the lint's one allowance expires with them: no pane composes a listing by hand, and CI fails one that tries.

### Patch Changes

- 4da6ea7: chore(argus): reaching past the Listing façade is the violation (#428, S5)

  `listing-is-one-abstraction` now fails the gate for a pane that builds a `RosterOrder` or `ListingHost`, calls the row or capsule builders, imports the order or the host, or spells `--roster-cols` by hand in the stylesheet. The PACS pane is the one named allowance, printed as debt on every run until S4 converts it. The dead grid rules the converted panes left behind are gone; the grid-source law reads the façade's `.listing-row` in their place.

- f6f850a: fix(argus): the PACS progress bar spans the middle and lines up level over level

  The series level was designed with its bar beside the description; the patient level and the reshaped study level then put PROGRESS after every fact, at the far right, each level on a grid of its own — the patient bar began 277 px left of the study's. And the study grid's content-sized tracks (`minmax(0, 13em)`) narrowed per row, so a short name jogged every column after it for that row alone.

  At every level the columns now read identity, description, PROGRESS as the one `1fr` expanse, then the trailing facts, then the verbs. Every other track is a fixed length. The four leading tracks are the same widths on the patient and study grids and the series description is widened to meet them, so the bars begin at one x on all three levels; the patient row takes the same font size as its caps, since the tracks are in em. The query form follows the study grid: the provenance readout stands over PROGRESS, the QUERY control in the verbs column.

## 0.2.0

### Minor Changes

- 436afa2: feat: the files browser declares its listing (#428, S2)

  The files browser is the first pane converted to the `Listing` façade. Everything it used to assemble by hand — the order, the host, the chrome lookups, the filter block, the strip observer, the `argus:roster` parse, the action track, the indication model, the readout and the selection — is now a declaration: traits carrying their own grid tracks, a key, chrome by prefix, the row verbs, the selection, and a state composer that prepends CWD and STALE to the façade's parts. The pane keeps what a browser has beyond a listing: the card and preview projections as a painter, the cwd binding, the stale readout, and the content views.

  `--roster-cols` for the files body leaves the stylesheet — it is computed from the traits and written on the mount — so the grid can no longer be miscounted, and the node overlay browser, which declares no verbs, no longer reserves an action-track column it never fills. No behaviour changes: the browser's smoke scenarios pass together, unchanged but for one selector that now reads the façade's `.listing-selected` in place of the pane's old class.

- 6699b8c: feat: the listing is declared into, not wired up (#428, S1)

  Three panes assembled the same listing by hand — order, host, chrome lookups, filter block, strip observer, the `argus:roster` parse — and after the browser and the roster gained their verbs each had also added an action track, an indication model, a readout and (in one) a selection by hand, in two spellings. It cost something: the grid gained a track and the `..` row kept its old cell count, and a row one cell short shifts every cell after it into the wrong column.

  `Listing<T>` in `features/roster/listing.ts` is that composition owned once. A pane declares its traits (each carrying its own grid track), its key, its chrome by root and prefix, and what a row may do; the façade computes the grid template, writes `--roster-cols`, blanks the caps over leading ornaments, reserves the action track on every row and fills it on indication. Declared actions mint the track and split click from double-click; no actions means no track and one click. `rows_set` names the field, so a selection survives a filter and a re-listing and clears on navigation. Blocks carry an optional lead row outside the order, a painter may draw a block as cards, a state composer lets a pane prepend its own words, and a child level mints its caps per open group and reads one filter down the levels.

  Additive: `ListingTrait` gains optional `width` and `capped`; `RosterOrder` and `ListingHost` keep their signatures; no pane is converted in this slice. The app gains its first DOM unit tests (jsdom), which prove that every row holds exactly as many cells as the grid has tracks.

### Patch Changes

- Updated dependencies [53a736f]
  - @fnndsc/calypso@0.10.1

## 0.1.0

### Minor Changes

- da15f3b: feat(argus): the surface can be asked

  argus refused every question the session put to it — `the argus surface cannot answer prompts`, with `hiddenInput: false` as the stated reason. So `sudo` dead-ended in the web surface, a confirmation dead-ended, and no control could ask for a value the operator had not already typed.

  It answers now, in the **console**: where the session speaks, and where the scrollback keeps what was asked, so an operator can look back at the question as well as the answer.

  - **`text`** takes an inline line.
  - **`secret`** masks the field and enters the transcript as dots — never its text, never its length — which is what lets `hiddenInput: true` be declared honestly.
  - **`confirm`** puts YES and NO capsules beside the question, because a control that reads as what it does beats a letter an operator has to know to type. Typing `y` still works for a hand already on the keys.
  - **`path`** is answered here too for now, with its suggestion offered so answering is a rename rather than a whole path typed out. The errand that walks a browser for it is the next slice; until then a location is answerable rather than refused.

  A question outranks the command line while it is open: an answer is never dispatched as a line, and a queued line never jumps ahead of it. **Esc abandons**, which is an answer of its own — the command is told, and reports what it did not do.

  Two asks that never travelled were routed through the surface while here. `rm -i` built its own readline against `process.stdin`, so under a daemon its confirmation was put to whoever started the daemon rather than to the operator who typed the command — they would have waited forever for a question asked of somebody else's terminal. `upload`'s confirmation was untyped, and is now a yes/no like the download's.

  Verified live: `sudo` in argus asks for an administrator username, masks the password, leaks nothing to the transcript, and abandons cleanly. Law `a-question-is-answered-where-the-session-speaks`, smoke-enforced.

- 78d85ae: feat(argus): a location is asked for by borrowing a browser

  An ask is never a box. A `path` question opens the instrument that already shows that space: a **new** files pane beside the pane that asked — never an existing browser, since hijacking one loses the operator's place — anchored where the ask said, closing when the errand ends either way.

  Its controls ride a bar of its own across the top of the pane: the question as a caption, the composed path as an editable field, **MKDIR** for a folder that does not exist yet, and one verb that commits, reading the word the kernel sent (`EXPORT HERE`). The grill had put those on the mode frame; building it showed why they cannot live there — the frame is a narrow rail against the spine, right for a column of capsules and hopeless for a caption and a path, and it answers to what the _field_ holds, which an errand does not change.

  Three defects the live run turned up, each fixed here:

  - **The errand opened an empty browser, forever.** The daemon runs commands one at a time, so the listing that would answer the question queued behind the command that asked it: the answer waiting on the browsing, the browsing waiting on the answer. An instrument command now runs **beside** a command waiting on a question — the natural twin of the rule that an instrument may never ask. A pane's own read neither asks nor waits, and the daemon saves and restores the executing command rather than clearing it, so the outer command's output still finds its way home.
  - **The errand split beside the focused pane**, which can be one the current preset does not hold. A split beside a pane that is not in the tree fails silently, and an errand that never opens is a question asked of nobody. The host is now a leaf that is actually on stage.
  - **The anchor could be somewhere nothing can be written.** A session sitting in `/bin` or `/proc` is browsing a provider, not standing where a file lands, so the ask falls back to home rather than offering a destination that is refused the moment it is committed.

  Law `an-ask-borrows-an-instrument`, smoke-enforced. Two consecutive full smoke runs, 103 checks.

- 02ef648: feat: a write is checked before it happens, and says what it did

  A chooser can hand a write a place that cannot be used, so `--csv-to` stopped trusting the path it is given:

  - **A provider path is refused by name.** `/net/pacs/x.csv` is somewhere to browse, not somewhere a file lands, and CUBE's own refusal talks about an upload, which says nothing about why.
  - **A missing folder is made, and said** — a directory appearing without a word is the silent side effect this replaces. argus's EXPORT CSV no longer runs `mkdir ~/audits` behind the operator's back; it lowers to `--csv-to` with no value, so the destination is asked for.
  - **An existing table is never overwritten in silence.** It takes `--force`, and the replacement is reported.
  - **The pane states the path** the kernel reported writing, rather than leaving it to the console alone.

  Three things the live run turned up that no mock would have shown:

  - **`files_listAll` answers null for an empty folder AND for one that is not there**, so existence can never be inferred from it. Doing so reported a folder "made" that already existed, and a file "already there" in a folder that did not exist at all. Existence is asked of `files_path_isDirectory` now.
  - **CUBE answers a re-upload over a path it already holds with a 500, thrown.** An unhandled throw in a builtin does not stop at the command: under a daemon it takes the process, and every surface attached to it. The write is wrapped — a store's bad day is a refusal, not an outage.
  - **Deletion is asynchronous**, so removing a file and writing in the same breath races the store and answers 500 again — with the operator's old file already gone. `--force` now removes, waits for the path to stop resolving, writes, and confirms by listing afterwards, because a write reported without confirmation was seen to leave nothing behind.

  Both CUBE behaviours are recorded in `docs/CUBE-gaps.adoc`, with what the API could offer instead.

- 671b188: feat(argus): a control lives where it acts — the browser's drawer is sorted

  The browser's drawer held three scopes in one costume: FOLLOW CWD and ROOT HERE, which say what the pane is bound to; HOME and BACK, which move where the field points; and DOWNLOAD and DELETE, which act on a row. Six capsules on one strip, with nothing to tell an operator which of them would act on what.

  They are sorted now, and nothing new was added while sorting them.

  - **Binding joins the binding group**, beside LINKED FS, because what the next split creates and what this browser follows are the same kind of sentence. The pair reads as a radio, since a browser either follows the session or holds its place, and it reads back whatever changed the binding — the drawer, the language, or a split born rooted.
  - **HOME and BACK move to the mode frame**, the thing that answers to the field. They stand down while a diagram holds it: a graph is not a listing and has no home to go to.
  - **DOWNLOAD and DELETE leave the drawer.** The intents stay: they are host capabilities now, which the console language presses today and a row's own action track presses next, so neither control has to know where the other one is.

  What is left is two groups and a shorter sentence: shape the tile, bind a neighbour.

  Law `a-control-lives-where-it-acts` in `docs/aegis.adoc`, with a smoke scenario that finds each verb in its new home, finds the drawer with two groups, and walks a rooted browser home, into a folder, and back.

- ba1e5b4: feat: a PACS answer can be written as a table a spreadsheet reads

  `--csv` renders the answer; `--csv-to <cfs-path>` writes it into ChRIS storage; argus's EXPORT CSV lowers visibly to the second, as GATHER's SAVE already lowers, so the operator reads the command that ran.

  Two flags rather than one with an optional value: `--csv PatientID:1234` cannot tell a destination from a query expression, and guessing wrong writes a file named after a patient.

  **Why a CFS destination exists.** A local terminal needs none — `--csv > audit.csv` writes the operator's own disk, because engine and operator share a filesystem. A detached surface does not: the engine runs on the daemon's host, so a redirect lands on somebody else's machine (#415, where `>` also turns out to bypass the `engineFilesystem` capability built to prevent exactly that). A cohort's MRNs and study descriptions stay inside ChRIS, and the file browser or `download` retrieves them.

  **The table's shape carries the level above's doctrine**: a row per study, and a row for every patient that owns none. A table built from studies alone would silently drop the misses, which are what an audit is usually asking about. `ANSWERED` carries an ISO timestamp rather than `3 MONTHS AGO` — a spreadsheet sorts dates; a phrase is for a human glance.

  Every cell is quoted and embedded quotes doubled, the rule chili's `--csv` has always followed, now stated as a function rather than left inside a handler nothing else can call — so a study description like `MRI BRAIN, W/ AND W/O "GAD"` survives the trip.

- b5b0c8f: feat(argus): the MRN is the outermost level, and a miss is an answer

  The PACS listing gained its patient level — always, not only when a cohort was asked. Every patient asked gets a row, hits and misses alike, because the MRNs that come _back_ are by definition the ones with imaging, which makes the answer an operator usually wants — which of these two hundred have none — the invisible half of the result.

  Three states, distinguishable at a glance: a hit reads its counts, a miss reads `0` with a dim track, and a row nothing could be asked of reads `UNASKED` in the mars hue, its reason on the title — never a zero, because a zero says the PACS answered, which is the one thing a timeout did not do. The pane's bar carries all three as `FOUND 2 · NONE 2 · UNASKED 0`, derived from the rows so the summary cannot disagree with what is on screen.

  **ANSWERED is a column.** A fan-out replays some rows and troubles the PACS for others, so provenance is per row; sorting on it lifts the stale rows to the top, and a row with no answer sorts to the far end rather than pretending to be old.

  **Progress sums at this level too** — every series under a patient, added and never averaged — and a level holding one row opens itself at every level, so an accession query still costs no gesture while a cohort arrives folded.

  Two things the live run settled:

  - The FILTER pill read the _study_ order's strip while toggling the outermost one, so it reported OFF with the strip standing open.
  - The study level is not indented. The form's DATE, ACCESSION and MODALITY fields stand over the study caps, and an indent pushed those columns 26px out from under the fields that fill them; the nesting is said by an inset shadow, which costs no horizontal space.

  Law `a-set-says-what-became-of-every-member`, smoke-enforced (`SMOKE_PACS_COHORT`), alongside five new scenarios over a live cohort.

- a245b5f: feat: choosing which PACS to ask is a strip you pick from, never a sweep

  SERVER became a column of the study listing, and the law that places a form's fields put its control there with no separate decision to make: the cell stands in SERVER's column, wearing the form's own label.

  It is a **state readout you press** — `PACSDCM`, `PACSDCM +2` — that unfolds a strip of segments beneath the form, one per registered server, lit when included; the field's touch or Esc retracts it, the same retraction grammar the mode frames already use. Not a dropdown: LCARS has no popup layer and should not grow one, since a floating menu is exactly the window chrome this grammar rejects — and a strip of the pane's own width carries thirteen servers where a grid track could not carry three.

  **There is no ALL, and there will not be one.** Thirteen registrations of unknown liveness would mean thousands of C-FINDs mostly into the void. A fan-out is always something the operator named.

  **One chosen is a context; several is a query.** One lowers to a visible `pacs connect`, so the session moves and the linked terminal's prompt follows. Several lowers to `--pacsserver a,b` in the editable line and moves nothing. The prompt changing, or not, is the honest tell.

  **The list comes from the kernel, not from CUBE.** `pacs list` now carries a `pacs.servers` model beside the text it always printed — id, identifier, and which one the session is on. A surface asking CUBE itself would be reading a different CUBE from the one its commands run against. Liveness is deliberately absent: CUBE registers servers, it does not test them, and a field that looked like health would be a claim nobody checked.

  Two things found live: the PACS pane's own commands had no way back to it — the DAG pane's already did — so `pacs list` answered into the void; and the document's retraction listener closed the strip with the very press that opened it.

  Law `a-server-is-named-never-swept`, smoke-enforced.

- 9e2a9dd: feat: a verb that acts on the place rides the frame — MKDIR and UPLOAD

  Two verbs act on the PLACE the field holds rather than on any row, so they ride the field's own frame beside HOME and BACK, and they appear on a browser's frame and nowhere else — there is no directory to make in a list of feeds.

  **MKDIR** asks for a name in the console and makes it where the field points, not where the session's cwd happens to be: a rooted browser is showing a place of its own, and a verb that acted on the session's place instead would make the folder somewhere the operator is not looking.

  **UPLOAD** is the verb this surface could not previously speak at all. `upload` reaches the daemon's disk, which a browser has never seen. So the operator's own picker chooses the file, and the bytes travel over the daemon's `/vfs` route — now answering `POST` as well as `GET` — where the **engine** writes them through the kernel. No surface talks to CUBE, the same attach token gates the write as gates the read, and the body is capped. The console keeps the account, because a gesture the surface performs itself still owes the transcript what it did.

  New seam: `Engine.file_write(path, bytes)`, the twin of `file_read`. It writes through salsa's own create and **invalidates the listing it changed**, as every writing builtin does — without that the browser asks for the folder again and is served the folder as it was before the delivery, which reads as an upload that silently did nothing.

- 801a41a: feat(argus): a plugin is the one-node case, not a wall of text

  `/bin` held two kinds of thing that behaved like two applications. A pipeline was a picture you could open; a plugin was prose you scrolled — the wall of scraped text the operator called exhausting.

  A plugin is now the graph with one node in it, and there is no third rendering:

  - **preview** — its card carries that node, drawn by the shared ranked layout a pipeline's card uses. It costs no fetch: a plugin is one node whatever it declares, where the card used to spend a `cat` per entry to print a paragraph.
  - **detail** — the same stage with the same mode frame, so PULSE, RANKED/MOLECULE and 2D/3D act on it as on any graph.
  - **immerse** — its node opens as its parameters, flag on the left and what the flag takes on the right, from the `plugin.info` model.

  A pipeline node reads out the arguments an author already FIXED; a plugin reads out the ones nobody has fixed yet. One painter renders both, so the two readouts cannot drift.

  **A view is closed by the operator, never by an arrival (#425).** Found live while proving this: opening a /bin entry fetches its graph into a mount, and a listing arriving a moment later replaced the whole view — the fetch then resolved onto a mount no longer in the page, and the stage stayed empty. A listing now lands under whatever is being read, and CLOSE or Esc shows it. The smoke scenario that slept three seconds to dodge that race no longer needs to.

- a8449bc: feat: the roster shares, and a feed can be removed

  `setfacl` grants to an identity and applies to a feed, so the feed roster is where sharing belongs — a browser row offers SHARE only because the path it holds names a feed.

  The roster's rows learn the split the browser's already have: a click indicates, a double-click enters, and the action track is reserved on every row so a roster with verbs does not jump when one row starts speaking.

  - **SHARE** asks who, and the question itself says a grant cannot be taken back. The irreversibility is stated where the grant is made rather than discovered afterwards, and because the sentence lives in the kernel's ask, every surface says it.
  - Beside the verb, the row **reads back who already holds it** — a readout, not a verb: it says what the grant would be adding to.
  - **DELETE** lowers to `feed rm`, which is new: the kernel could delete a feed but no shell verb could. It asks first by default, naming the feed and what goes with it, and takes `-f` for a caller that has already asked its own question.

  `feed rm [<feed>] [-f]` joins the feed subcommands.

- 8446459: feat: a row is indicated before it is acted on

  The browser's rows have their verbs. Two problems had to be solved before they could:

  **There was no indicate gesture.** A click entered a directory, opened a file, opened a `/bin` entry — nothing meant "this one" without also meaning "go". A click now indicates and a double-click activates: the split the DAG scene already teaches, and what every file manager does. Only a listing that hides its verbs learns it — a browser given no verbs (a node's overlay) keeps its single click, since asking for a second click while offering nothing for the first is a worse bargain than the one it replaced.

  **A row that grew when indicated would make the listing jump.** The action track is reserved on every row at the capsule's own height, declared once and read by the track and the capsules alike, so what changes when a row speaks is what the track holds and never the geometry around it.

  Each verb lowers to a command the operator can read in the transcript:

  - **DELETE** → `rm -i` (`rm -ri` for a directory), so the kernel raises the confirmation and one confirmation grammar serves every surface.
  - **MOVE** / **COPY** → a one-operand `mv` / `cp`, whose missing destination is the ask that opens the errand.
  - **DOWNLOAD** → the file, as before.
  - **SHARE FEED n** → on any row whose path holds a feed, naming the feed because CUBE grants a feed and never a file, with the grants that already exist read out beside it.

  A `/bin` row is offered nothing: an executable the catalogue lists is not a file in a store.

  `setfacl <feed>` with no entry now **asks who to share it with**. A path and no entry names what to share and not with whom, which is a question rather than a usage error — the same law that made `mv foo` ask. Abandoning it shares nothing and says so.

- 17964a9: feat: SELECT is a mode, and a selection has verbs

  A mode describes how the field behaves, and this one changes what a click means. While SELECT is on a click gathers a row instead of indicating it, row verbs stand down — a row is not indicated then, it is selected — and the bar reads `SELECT · 2 SELECTED`, adding `· 1 SHOWN` when a filter hides some of what was gathered, since a verb acts on the selection and not on what is on screen.

  The selection belongs to the **field**: it survives a filter (which is how a selection gets built in a folder of hundreds) and the same rows arriving again; it is cleared by navigation, because a selection that follows the operator elsewhere is one they can act on without seeing; and leaving the mode clears nothing. Esc leaves SELECT before it retreats anywhere — but never while a question is open, since abandoning a question is an answer and one press must not answer two things.

  Its verbs ride the frame, and each is ONE command the operator could have typed:

  - `rm -rI "a" "b"` — **new `-I`**: one question for the whole list, naming how many, rather than one per file. A refusal removes nothing at all; there is no half of a set.
  - `mv -t` / `cp -t` — **new `-t <dir>`**: names a target directory so every operand is a source, and given no value it asks, wanting a directory.
  - `setfacl` over the **distinct feeds** the selection touches, which asks who once for the set.

  ## A defect this bought, and the guard for it

  The live run found the surface lowering a two-file selection to `mv a b` — which the shell correctly reads as "rename a onto b", and which moved one file of the pair onto the other. Chasing it turned up something worse and older: **a move onto a path the store already holds leaves a row CUBE's own API cannot serve, and one such row makes every listing of that folder fail** — the poisoning first seen in #462, now reproducible in three commands.

  `mv` refuses that move by name instead of attempting it, which costs one listing call and keeps the folder readable, and a failed move now reports the reason the kernel gave rather than a bare "Failed to move".

  Also: a browser re-lists after a verb that changed the folder it is showing (`fs.rm`, `fs.mv`, `fs.cp`) — `rm` reports what it removed, not where it removed it from, and a listing that keeps showing rows that are gone is a listing lying about the store.

### Patch Changes

- 3df1c41: docs(calypso): say calypso where the component is meant, and make it typeable

  Every other part of the stack is a noun with a role — cumin, salsa, chili, brasa, menu, chell, argus. The session supervisor was the odd one out, described by a flag on another program, so the prose said "the daemon" for something that already has a name, a package, a binary and a doctrine document.

  Host control is _calypso's_ policy; berths are calypso's; the wire is calypso's. "Grant calypso host access" says whose policy changed. "Grant the daemon" does not.

  Operator-facing text now names it: the flag help, the not-running message, the already-running refusal, the listening banner, the attach errors, the several-sessions chooser, and the host-control sentences — `upload` refusing without the `files` tier, the HOST banner, and argus's HOST lamp tooltip.

  The start hints used to read `chell --daemon <user>@<url>` while the prose said "run calypso". They now say `calypso <user>@<url>`, which is a real command, since calypso ships its own binary. The getting-started guide leads with what calypso _is_, then gives both ways to start it — standalone from a saved session, or through chell logging in fresh — because they genuinely differ and one does not replace the other.

  **Daemon survives where it is correct**: a mode name, an anchor, a make target, a background process. Code symbols are untouched — `daemon_launch` and its kin describe something that really is a daemon, and churning them buys nothing an operator sees. Command lines inside code blocks were left alone, so nothing became a command that does not exist.

- 04004cd: refactor(argus): one frame-and-field host for the tabular panes

  The files listing and the runs roster arrived at the same arrangement separately — mount a `RosterOrder` frame, append a scrolling field beneath it, fill the field with rows — so the arrangement was copy rather than shared code. A fix to one had to be written again for the other, and the stylesheet carried two field rules differing only by a `padding-right`.

  Both now use one host. The duplicated `field_open` is gone from each panel and the two rules collapse to a shared `.listing-field` plus a one-line files override.

  The host is deliberately narrower than planned. It was to own the state line and the empty state as well, but reading the panels closely those only resemble each other: the files bar toggles a single class and joins parts, while the runs bar swaps among three liveness classes and stays silent while a graph is on stage. Pulling them together would have changed behaviour, so they stay put, and the reasoning is recorded in the module rather than left to be re-litigated from resemblance.

  Nothing an operator sees changes. The argus smoke suite passes unedited at 63 checks, which is the evidence.

- 116e8ba: feat(listing): progress is a trait of a row, and a row can carry verbs

  The operator's observation: progress is not a PACS quirk. A feed row should say how far its work has got without anyone opening it, and every level should report — a series its own pull, a study the sum of its series, a patient the sum of its studies.

  **The wire could not say it.** The `feed.list` model carried id, title, owner, status, created and two totals that need resident topology, so a roster genuinely could not know a feed's progress. CUBE's own job counters were already on the process cache, so the kernel now derives `jobsDone` and `jobsTotal` from them — settled meaning finished, errored or cancelled — and they travel with the feed row rather than waiting for topology. Kernel, wire, surface, in that order.

  **Progress aggregates by addition, not by average.** A study's progress is the sum of its series'. An average would let one finished series of a hundred files outweigh a stalled one of ten thousand.

  **A row with nothing scheduled still gets a track**, dimmed. The absence of a bar reads as "no such thing"; a dim track reads as "nothing has happened yet", which is the truth and the more useful statement.

  **Actions are not traits.** A trait says what a row is under some column; an action is a verb applied to it, and it sits outside the column grid because it answers to no cap. Capsules stop click propagation, so pressing one is not also activating the row.

  **Expansion has two modes**, declared rather than assumed: `replace` leaves the parent behind, `fold` keeps it on stage with the child inside. PACS exercises both in the next slice.

  The runs roster gains NODES and PROGRESS, which widened its positional track list from seven columns to nine.

  One smoke assertion changed, and deliberately: it counted seven cells per row as a literal. It now counts cells against the number of caps, which is the invariant that actually protects a positional grid and needs no edit when a column is added.

- c721edc: refactor(argus): a listing column is declared once

  Both tabular panes said what their columns were twice: once to `RosterOrder`, which draws the caps and sorts by them, and again in the code that emitted each cell. The two could not drift visibly, because the grid would break, but they could drift in meaning — a cap saying one thing while the cell beneath it showed another.

  A trait now carries the cap's label, the cell's class, what the cell holds and how rows compare under it. `RosterOrder` takes its caps and its comparator from the same declaration that emits the cells, so the two cannot disagree.

  Comparison defaults to the cell's own text, so a column declares an ordering only where display and order genuinely differ: a size shown as `1.2 MB` sorting by bytes, a date shown short sorting by its full stamp.

  Row state stays out of the model. `files-denied`, `feedlist-arrived` and the status classes mark a row, not a column, and forcing them through a column model would say something false about them. A pane supplies them through its own hooks, and the module records why so the next reader does not unify them on resemblance.

  Nothing an operator sees changes. The argus smoke suite passes unedited at 63 checks, including the scenario that sorts and filters by these very columns.

- e5483dd: fix(argus): state wears the theme's colours, not literals

  The operator noticed the PACS progress bar was "all green-ish, looks out of place". It was: a hardcoded `linear-gradient(90deg, #2a5, #3c6)` on a surface where every other colour is a theme token. Looking properly, there were ten such literals — feed status, PACS badges, the subway diagram's failed stop, the offline lamp, the audio pill, the attach error — each ignoring whichever LCARS scheme is active.

  Worse, `--mars` was **referenced five times and defined nowhere**. Every rule using it had been silently inert: the refused-row colouring added yesterday, its strike-through tint, and the WARM-UP FAILED readout were all falling back to inherited colour rather than showing red. An undefined custom property fails quietly, which is why it looked plausible.

  State hues are now declared once and derived from the theme's seven base colours, so they follow the scheme: done from daybreak, running from orange, idle a dimmed pumpkin-pie for a track where nothing has happened yet. Error is the deliberate exception, mixed toward the palette rather than taken from it, because danger must not blend into a warm scheme.

  Chrome that is red _by design_ rather than by state — the LCARS close pill — gets a real `--mars` token of its own, so the two meanings stop borrowing each other's colour.

  No literal state colours remain. Smoke passes unedited at 63 checks.

- Updated dependencies [a7f057c]
- Updated dependencies [78d85ae]
- Updated dependencies [3df1c41]
- Updated dependencies [116e8ba]
- Updated dependencies [7181f7e]
- Updated dependencies [d2a4315]
- Updated dependencies [a245b5f]
- Updated dependencies [9e2a9dd]
- Updated dependencies [5a339f0]
- Updated dependencies [62761a3]
  - @fnndsc/calypso@0.10.0
  - @fnndsc/menu@0.4.0

argus is not published to npm, so changesets writes no changelog for it. This file is that record, kept by hand.

## 2026-09-04

fix(argus): the operator divides the stage, not a constant

The console could not be dragged past roughly half the frame. The drag had no cap of its own; the wall was a `min-height: 20rem` workspace floor on `main`. A floor there is a ceiling here, because the drawer can only grow into space the workspace will give up, and the floor was lifted only for the console's own zoom.

The floor is gone. The drag is now bounded only by what the screen imposes: a minimum so the strip stays grabbable, and a ceiling that keeps the console's own header on screen so the controls that shrink it again remain reachable.

fix(argus): the PACS listing uses the space it has, and the header slide stops guessing

**The progress bars sat where there was no room.** A series row put the description on `1fr` and the bar in a fixed cell wedged between the file count and the capsule, so the description hoarded a thousand-odd pixels of empty width while the bar had a few dozen. The description now takes what it needs up to a limit and the bar takes the rest, stretching from the description across to the modality.

**Enter runs the query** from any term field, not only the command line. Filling a field and pressing return is what a form means.

**Waiting is visible.** A query in flight shows a pacing bar and says so, rather than one line of static text that reads like a finished empty result. A pull in flight now draws a bar that fills by current over total, and paces when there is no total instead of pretending to a fraction it does not know; previously it only changed a word.

**A study wears the same frame as any other listing**, in the roster's own idiom: a bar of caps naming SERIES, STATE, MODALITY and FILES, sharing the row's track definition so each cap sits over its column.

**The header's slide distance is no longer a stale measurement.** It was captured once at the moment of the gesture, but the header's height is not fixed — version rows arrive from the daemon after attach — so the slide could fall short by anywhere from one to thirteen pixels depending on timing. It now tracks the header's resting extent and freezes during the slide, since zooming hides the lid and makes the header shorter than the distance it has to travel.

fix(argus): runs-02 gets the same frame treatment, and 02-CALYPSO matches ARGUS WEB

The runs roster shared one scrolling box with its caps, so its scrollbar ran the full height of the pane and up behind the frame — the same defect the files browser had. The caps now sit above a scrolling field, and the roster shows as a flex column rather than a block.

The version face stops being its own design. It had picked up a private set of overrides — smaller label pills, shrunken fonts, tightened line heights, a bespoke grid — none of which the ARGUS WEB face uses. They are gone. It now uses the same three-column idiom, the same type and the same pill width, verified against a live daemon: both faces report three columns, a 15.4px label, a 19.8px value and a 209px pill. The cycler gives back the width to make room, from two fifths of the band to under a third.

One structural correction stays: the columns belong on the readout, not on the face. The rows live inside an `about-rows` wrapper, so columns set a level above it fragment the wrapper rather than its rows, which left every row in the first column and the rest of the band empty.

Values still elide rather than wrap, so a long git hash or build date cannot disturb the layout, with the whole text on hover.

test(argus): the smoke suite waits for motion to stop instead of guessing how long it takes

Several scenarios slept a fixed number of milliseconds after a gesture that animates, then measured. That samples a CSS transition at an arbitrary moment: sometimes mid-glide, sometimes before the click had even registered. The header-slide check drifted between one and thirteen pixels of residue and occasionally read the header's full resting position, and the split-zoom, restore-strip and mode-frame checks flickered alongside it.

Scenarios now wait for the value under test to stop changing. The checks are stricter as a result, not looser: the header-slide tolerance goes back to a single pixel, where it had been widened to two to accommodate the noise.

No production behaviour changes here. The one thing worth stating plainly is what this was not: the slide distance was correct throughout, and two attempts to "fix" it in the page were reverted once the suite could measure it honestly.
