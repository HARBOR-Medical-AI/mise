# @fnndsc/brasa

## 0.51.2

### Patch Changes

- Updated dependencies [f6790b6]
  - @fnndsc/menu@0.32.0
  - @fnndsc/chili@3.8.2
  - @fnndsc/cumin@3.29.5

## 0.51.1

### Patch Changes

- 0ee1344: A `/bin` pipeline refuses an operand beside `--previous=N` as it does beside `--previous N`.

  The check matched only the bare word, so the `=` form, before or after the operand, slipped past and the input was said twice (#1313).

## 0.51.0

### Minor Changes

- 8fd7226: A bare plugin name at the prompt runs the highest version `/bin` lists for it, and says which.

  `/bin` lists a plugin per version, `pl-freesurfer-v1.0.4`, and a bare `pl-freesurfer` matched nothing there, so it fell through to chili and was refused. Now the bare name resolves to the highest registered version on the connected CUBE and prints the resolution as it dispatches, `running pl-freesurfer-v1.0.4 (highest of 1.0.1, 1.0.4)`, so the line read back names exactly what ran. The full name keeps working and pins the version; `help pl-freesurfer` answers with the highest version's help; `/bin` itself is unchanged, since the answer is derived from CUBE's state rather than kept as shell state (#1303). Versions order as dotted numbers, so 1.10.0 stands above 1.9.9 and 1.0.4 above 1.0.4-rc1. Inside a pipe or a redirect a bare name still starts no job.

- ec2d610: A plugin's parameters tab-complete after `--` on its `/bin` line, full name or bare.

  `pl-freesurfer-v1.0.4 --<tab>` offered nothing: only a pipeline's line completed its `--node.field` options. Now the first word is read as a plugin, by its full name or its bare name (the highest version, as the run resolves it), its parameters are fetched once from CUBE as `--parameters` reads them, and `--ex<tab>` gives `--exec`; a boolean parameter completes as its flag alone. A pipeline's line completes as before (#1306).

- 68d09fc: A path tab-completes after a `/bin` plugin or pipeline name, where its operand goes.

  With #1303 a `/bin` run takes an input operand, and `pl-freesurfer ~/up<tab>` offered nothing: a path completed only after a fixed list of file commands. Now the first word is asked of the session: a plugin `name-vVersion`, a bare plugin name, or a pipeline by its `/bin` name or its own name takes paths, and its operand completes as `ls` and `cp` do. Only operand positions complete: an option word does not, and the word after `as` is a subject's name (#1305).

- 71f3c63: A plugin or pipeline run from `/bin` takes its input as an operand: a directory, or files shaped into subjects.

  A `/bin` run used to take the working directory only. Now `pl-freesurfer-v1.0.4 ~/uploads/subjects` runs on that tree: inside a feed, that node is the input and the run continues the feed; outside one, pl-dircopy roots a new feed of it first, as it did for cwd. A file operand is one subject: chell copies it to `~/.mise/stage/<id>/<subject>/<file>`, named by the file's stem (`t1.nii.gz` is `t1`) or by `as <name>`, roots a new feed of the stage, and prints the subject and the path CUBE made of it. Several files are several subjects; `t1.nii t2.nii as sub-01` is one subject holding both. Operands come first on the line and the plugin's flags after; a flag before an operand is written with `=`. A path is read as given, a directory when one stands there, a file otherwise, and a missing path refuses. To an fs plugin an operand is its `dir`, untranslated. Pipelines take the same operand, and one outside a feed now roots a new feed rather than refusing (#1303).

## 0.50.1

### Patch Changes

- c742135: An identity that sees thousands of feeds can log in again: the boot no longer waits on CUBE's slow feed list (#1280). The token check reads `users/` instead of the API root, which is the feed list and took up to 22 s for `chris`; a CUBE that does not answer the check is said to be silent, never to have refused the token. Each client reads its root once for every caller, and feed-list pages wait 120 s instead of chrisapi's 30. A cold boot walks the feed index behind the listening daemon, as a restored one already did, so the session answers the door before its 120 s wait runs out; a `/proc` read that arrives first joins the walk instead of starting a second.
- Updated dependencies [c742135]
  - @fnndsc/cumin@3.29.4
  - @fnndsc/salsa@4.4.3

## 0.50.0

### Minor Changes

- 41769da: Each surface keeps its own last answer, so `@3` counts the listing that surface read. A listing read in a browser no longer renumbers the rows a console is about to act on: calypso hands every line its surface as origin, the kernel keeps one answer per origin, and a numbering goes only to the surface whose line listed. A surface that leaves takes its answer with it; one that attaches has listed nothing yet (#1273).
- 0efbb7c: A PULL in ARGUS runs in the background: the console and every other press stay yours while a retrieve goes on. The press sends `pull … &`; the badges follow it as before, each running joblet is a row on the LANE instrument with a STOP that types `kill %N`, the console prints when one starts, ends or waits for an answer, and RESTART names the joblets it would end (#1273).

  A joblet relays its progress, and any model it answers with, to the surface it came from; its task carries its progress. The heartbeat's lane lists the running joblets, calypso answers `GET /joblets` (token-gated), and a porter login that finds a session on older code keeps it, rather than restart it, while joblets run.

- b8bc519: A line ended with `&` runs in the background as a joblet, so a long pull no longer holds the console it was typed in. It is kept at `/proc/joblets/<N>` with its output in its log; its surface hears `[1] … &` when it starts and `[1]+ Done`, `Failed (exit N): …` or `Stopped` when it ends. `joblets` lists them, `fg %1` answers what one waits on and follows it, `kill %1` and `wait %1` stop and follow one. A joblet stands where its line was typed with that line's variables, its own `cd`s and assignments staying inside it, and holds what its line changes in the same lane as every line; one that needs an answer pauses until someone brings it forward (#1273).

  Every session's runner now carries the core's `joblets` source (a runner source may be `ungated`, needing no tier, and words its own end `notice`, sent to the surface in `data.origin`). An ambient `envelope` event may name its `origin`; calypso sends it to that surface while it is attached. A `Surface` may offer `hold(holds)`, which calypso answers from its lane (`hold_take`). `cwdScope_run` takes a start folder, and a `cd` under one stays in it.

- 56debd5: A read runs while another line works: `ls` in a browser comes back while a PACS pull runs in a console. Each command says what it changes of the session, and calypso runs lines side by side unless they change the same piece: a read holds nothing, `cd` holds the working directory, `gather` the cohort, and a command that has not said holds the whole session, so it waits and is waited for as before (#1273).

  Each line keeps its own slot in calypso (its surface, its questions, its STOP) and in the kernel (its cancellation, a played manifest's depth and recorder mute, and the directory it stands in, read once when it first asks), so the per-command hand-over a question used to need (`turn_leave`, `turn_resume`, `turn_abort`) is gone; a STOP names the line it reaches. `tree` and `du` scan a named folder where it stands (chili's `scan_do` takes a `folder`) instead of moving the shared directory there and back.

### Patch Changes

- 7a10507: Lines that run at the same time now keep their own success or failure and pipe input (#1273). Nothing changes yet in what a line does; this is what lets a later change run a read beside a writer, and background jobs beside both.

  Each line has its own exit status: `exitCode_set` and `exitCode_read` in `core/handlerRun.ts` replace the 243 writes of `process.exitCode`, and a top-level line runs in `exitScope_run`, which leaves its code as the process's when it ends, so a one-shot `chell -c` exits as before. A pipe segment's piped text and listing are held in slots of their own (`stdinScope_run`, `listingInScope_run`).

- Updated dependencies [41769da]
- Updated dependencies [0efbb7c]
- Updated dependencies [b8bc519]
- Updated dependencies [56debd5]
  - @fnndsc/menu@0.31.0
  - @fnndsc/chili@3.8.1
  - @fnndsc/cumin@3.29.3

## 0.49.1

### Patch Changes

- b53c0cf: A run started from inside a node's output now attaches to that node, not to a folder that merely looks like one (#1268). In `…/pl-dircopy_734517/data/subject_01`, a plugin or pipeline run used to start from instance 1, because the path reader took the deepest folder named `<anything>_<number>`. The node is now the last `<name>_<id>` of the chain right after `feed_N`, and nothing at or below a `data` folder counts. Plugins, pipelines and `proc here` all read it this way.

  A play whose starting folder cannot be given back at its end (removed during the play) now says so in one line instead of throwing over the play's own result.

- b6b0414: A pipeline now runs from the feed node you are in, as a plugin does (#1263). `cd ${FEED.path}` and then a pipeline from `/bin`, or `pipeline run <name>`, with no `--previous`, starts from the deepest `pl-*_ID` on the working directory's path, from the node itself or from inside its `data` folder. It used to read a saved plugin context that `cd` never sets, so the line was refused with "no plugin instance in context". Outside a feed node it is refused by name: cd into a feed node, or give `--previous <id>`.
- 9cfdf97: A play now hands back the working directory it began in when it ends (#1264). A manifest that does `cd ${FEED.path}` to run a pipeline from that node no longer leaves the shared session, and every surface on it, standing inside the feed. The directory is given back however the play ends: at its last line, at a refused line, at a `--pace` stop, or when interrupted. Inside the play a `cd` holds as usual, and a `--dry-run` moves nothing.
- Updated dependencies [b53c0cf]
  - @fnndsc/cumin@3.29.2

## 0.49.0

### Minor Changes

- e9ea847: A session can now write words and formatted text: `echo` and `printf`. `echo` writes its words on a line, with no options and no escapes (`-n`, `-e` or `-E` as the first word is refused by name), so `echo feed ${R.feedId}` shows a variable's field. `printf` is POSIX's subset: `%s`, `%d`, `%i`, `%%` with flags, width and precision, the escapes `\n`, `\t` and `\\`, the format reused while arguments remain; anything else is refused by name, and the text always ends its line. Both answer with text, so `A=$(printf …)` holds what was written.
- f8b07e0: A backslash inside single quotes is now just a backslash, as in any POSIX shell (#1258). `grep '\.mgz$'`, `find … -name '*\.nii'` and `printf '%s\n' a` reach their command with the backslash they were written with; before, the line dropped it, so a pattern meant "any character" where it said a dot.

  Quoting follows POSIX throughout: inside single quotes every character is literal; inside double quotes a backslash escapes only `$`, `` ` ``, `"`, `\` and newline (`"a\"b"` and `"\$HOME"` work as before) and stays before anything else (`"a\b"` keeps it); outside quotes it escapes the next character. The word parser and the `;`, `|`, `>` and `$( … )` splitters read one rule (`lib/quoting.ts`), so none of them splits a line its words read otherwise. A line that relied on `\'` inside single quotes, such as `'it\'s'`, now closes the quote there; write `"it's"` or `'it'\''s'`.

  ARGUS quotes the lines it writes (an EDIT save, a cohort's `gather add`, a tag) the same way: single quotes, with a single quote written `'\''`. Its old quoting doubled every backslash and wrote `\'`, which under these rules doubled a backslash on every save and refused text with an apostrophe.

### Patch Changes

- e12598c: Finding jobs by pipeline run is complete about seven times sooner on a large account (#1253). Which pipeline run made each job is read again, behind the prompt, for jobs an older checkpoint lacked, and that read took hours.

  The jobs it lacks sit in a few big feeds (on one account three feeds held all 118k), and they are each feed's older jobs: CUBE lists a feed newest first, and an earlier pass had already learned the newest. The read now starts each feed where the unknown jobs begin instead of at its head, reads pages in parallel across all its lanes instead of one feed page after page, and reads a feed whole when the skip missed any. Measured on that account: about 5,000 jobs learned a minute, from about 700.

  `proc stat` says how far it has come while it reads: `pipeline runs : reading behind the prompt, 155/1061 pages`.

- 26df4e2: A line whose quote never closes is now refused instead of run (#1260). `ls 'x; pwd` ran `ls` on `x; pwd` as if the quote closed at the end of the line; now chell says `the ' at column 4 never closes; nothing of the line ran` and exits 2, and no part of the line runs, not a batch's first command or a pipe's first segment. A manifest stops at such a line. A `!` line is the host shell's to read and is not checked.
- Updated dependencies [e12598c]
  - @fnndsc/salsa@4.4.2

## 0.48.2

### Patch Changes

- 7b0cc57: The cohort band redraws when `gather process` or `pull --new-feed` changes the cohort, typed anywhere (#1252). Both commands changed the cohort (its feed, where its series landed) but answered only with their run or the feed they made, so a surface showing the cohort did not learn of it.

  Each line still answers with its own result, so `R=$(gather process …)` holds the run and `F=$(pull --new-feed …)` the feed, as before. The cohort goes out on the session bus as well, and ARGUS's ChRIS routes adopt a `gather.cohort` arriving there the way they adopt one a line answers with.

## 0.48.1

### Patch Changes

- 21614a7: Gathering a series answers in about six seconds instead of ten: `gather add` writes the cohort once. It asked CUBE where the series landed after writing the cohort file and then wrote it again; now it asks first and writes once with the folders in it. Every gather verb also stops asking CUBE to make `~/gather` each time once the folder is known to be there, which saves about a second each.

  A cohort write CUBE does not take is now refused (`gather: could not write …`) instead of being passed over. A write that fails because `~/gather` has gone since makes the folder again and writes once more.

- eba14cc: A folder you just removed no longer comes back in `ls`. CUBE accepts a folder's removal (202) and finishes it a moment later; until then its parent still lists the folder, and a listing read in that moment (the `ls` after `rm -r`, a pane's refresh) was kept as current, so the removed folder stood in `ls ~` for as long as the cache trusted that listing.

  `rm -r` and `rmdir` now return once CUBE has finished: they wait, 15 seconds at most, for the parent to stop naming the folder, and say so in words if it still does (`CUBE accepted the removal of … but still lists it after 15s`).

  The listing cache also no longer keeps a listing that a change overtook while it was being read. A read takes a stamp before it asks CUBE (`stamp_take()`), and `cache_set(path, data, { since })` does not keep a listing whose folder, a tree above it, or the whole cache was invalidated after that stamp. brasa's VFS takes the stamp for an `ls` and for the refresh behind a stale one.

- Updated dependencies [eba14cc]
  - @fnndsc/salsa@4.4.1
  - @fnndsc/cumin@3.29.1

## 0.48.0

### Minor Changes

- 4bc9d87: The dashboard and every other line keep working while a long build is being followed.

  Following a task (`domain build`, `wait`) steps out of the session's turn between the task's lines, as a question already did, so a pane's reads run meanwhile; STOP still reaches the follow. A line whose browser has closed can now be stopped from any surface. A line typed in one browser never opens on another.

- 02c20bf: Every function name now says what it does: the 462 that put a preposition where the verb goes are renamed (#1227).

  The style guide names a function `<subject>[Qualifier]_<verb>[Adverb]`. Names such as `answerRows_of`, `seriesUID_ofPath`, `options_toParams` and `ask_onPane` put a preposition in the verb's place, which names the result without saying whether the function derives, parses, builds or renders it. They are now `answerRows_derive`, `seriesUID_parse`, `options_convertToParams` and `askOnPane_await`. A preposition may still qualify the verb (`x_readFromCache`) or the object (`askOnPane_await`); it may not start the method.

  `npm run lint:rpn` (`scripts/rpn-prepositions.mjs`) refuses a function, `const` function or underscored method whose method is, or starts with, `of`, `to`, `with`, `from`, `for`, `by`, `as`, `in`, `on` or `at`, and CI runs it. The exported names change with no aliases kept: nothing outside this repository imports them.

### Patch Changes

- 5602a4f: A dry run of a manifest now previews the lines the play would run (#1241). A capture `R=$(gather process … --title "${LABEL}")` is shown around the command it holds, where the preview used to split it as plain words and put the closing `)` inside the title.

  A reference the manifest itself changes before it is used stands as written instead of being filled from the session as it was before the play: `${gather}` after a `gather` or `pull` line, `${cwd}` after a `cd`, an `@` index or `${listing}` after any line, a variable the manifest assigns, and anything after a nested `play`. The preview used to name the cohort the session held before the manifest's own `gather clear`, so `pull ${gather}` showed folders the play would never fetch. A `ReferenceSource` says which verbs change it with `changedBy`; one that does not is held after any line. An `@` index that stands in a preview stands as `@SER3`, not `${@SER3}`.

- c58c3a6: Searching tags, groups, workflows, plugin metas or jobs by a term works again (#1237). `<resource> search <term>` used to read the term as a subcommand and refuse it (`Unknown subcommand: feed_id:5536`). The other options on the line now carry into the listing, and a search with no term or more than one is refused by name.

  A resource `list` refuses an option it does not read instead of printing the unfiltered first page: `jobs list --feed 5536` answers `jobs list: unrecognized option '--feed'; filter with --search <field>:<value>`. The options it reads are the standard ones its help lists (`--all`, `--limit`, `--fields`, `--sort`, `--reverse`, `--search`, `--table`, `--csv`, plus `--page` and `--offset`).

  The help for `plugininstance` (and `job`, `jobs`, `instance`, `instances`) no longer lists `cancel`, `delete`, `output` and `parameters`, which were never implemented. A job is worked in `/proc/jobs`: `proc find <id>` names its path, `rm` on it cancels or removes it, and its `params`, `log` and `data` live under it. Typing one of the old verbs says so.

- Updated dependencies [fd1711f]
- Updated dependencies [4bc9d87]
- Updated dependencies [02c20bf]
- Updated dependencies [55e2041]
  - @fnndsc/menu@0.30.0
  - @fnndsc/chili@3.8.0
  - @fnndsc/cumin@3.29.0
  - @fnndsc/fond@0.6.0
  - @fnndsc/orrery@0.7.0
  - @fnndsc/salsa@4.4.0

## 0.47.0

### Minor Changes

- e1d052d: ARGUS shows the kernel's cohort instead of keeping its own copy. Its GATHER, REMOVE, CLEAR, name and CREATE FEED presses send `gather add|remove|clear|name|feed`, and the band and the GATHER pane redraw from the `gather.cohort` model those verbs answer with, including a line typed at any chell on the session. ARGUS no longer writes `~/gather/current.json`.

  The kernel now fills in what the surface used to supply. `gather add` on a PACS path takes the series' description, modality, file count, patient and study from the query answer the path names (from the PACS mount's cache, so at most one CUBE read per query). A gathered folder is imagery when its name or place says it is a series, by the rule ARGUS's viewer uses, which now lives in `@fnndsc/menu` as `seriesFolder_is`. `gather feed [--title T]` makes the cohort's feed: series still at the PACS are pulled first, then one feed is rooted on every member, folders included. `gather name` answers with the cohort, and so does a `pull` that noted landed folders on it.

  `PacsVfsProvider.queryResult_fetch` is public, and `vfsDispatcher.pacs` names the PACS mount. `pacsQueryModel_build` moved to `builtins/net/query.model.ts` and is still exported from `query.ts`.

- b4cd618: Every session can play a manifest and make claims again: each backend registers what can be claimed about its world. `expect` keeps its grammar, `--within` and `path exists|count` in the core; ChRIS registers `gather`, `feed`, `run` and `path … tags`, and stratus registers `domain` (`step <name>`, `verify`, `class`, `cost`), so a tenant's manifest can assert its domain. `play` reads a manifest through the backend's files, then the engine's disk. A play no longer stops at its first line when an earlier command in the session had failed: each line is judged on its own status (#1056, stratus.adoc D14).
- caff86a: A variable can head a pipe and hand on what it holds: `${T1} | grep -i sag | gather add` re-filters a stored answer. Written as an argument a variable still becomes words; at the head of a pipe it hands its model to a builtin that reads one, and its operands as text to anything else (#1226).

### Patch Changes

- 6a766d2: A cohort gathered and pulled from a script reads as home: `expect gather unpulled eq 0` holds and `gather process` runs. Nothing in the kernel recorded where a pulled series landed, so only a cohort built in ARGUS could be processed. `pull` now notes each landed folder on the cohort, and `gather process` and `expect gather pulled|unpulled` ask CUBE for any series member not yet noted. A series gathered from a query's answer (`Series_<uid>_<description>`) now carries its UID (#1226).
- 52b9691: Help and docs now say three things that surprised in use. A fan-out plugin's run ends once its jobs are submitted. A pattern given to grep matches a study's own text too, keeping that whole study. With a default door, `chell -c` and `-f` run in your shared session (#1228).
- 9c9ec38: A pipeline can be named by its own name, not only its `/bin` name, in `gather process` and at the prompt. The `/bin` name carries the CUBE id (`…_id291`), so a manifest that used it ran on one CUBE only; `gather process "FreeSurfer 8.2.0 mri_convert per series, DICOM"` now runs on any CUBE that has the pipeline (#1226).
- d6cdb13: A variable holding a listing expands as a pipe hands it on: `gather add ${T1}` gets the series a grep kept. It used to add every patient and study row the grep kept as context, so `gather add` and `pull` took whole studies the grep had removed (#1226).
- Updated dependencies [e1d052d]
- Updated dependencies [a0fa450]
- Updated dependencies [05ec948]
- Updated dependencies [46bc80d]
  - @fnndsc/menu@0.29.0
  - @fnndsc/salsa@4.3.0
  - @fnndsc/chili@3.7.16
  - @fnndsc/cumin@3.28.6

## 0.46.0

### Minor Changes

- f2180c1: Variables: `A=$(cmd)` holds what a command answered and `${A.field}` reads it, so a manifest chains runs by name. `NAME=word` holds one word; a command with no model is held as its text, one operand per line; a failed command leaves the name unchanged and fails the line. `set` lists the variables and `set A` shows one whole; `unset` removes them. A play gets its own scope, its parameters read-only, and `@answers NAME` makes `X=$(play f)` hold that variable's model. `${gather}` is read live by the same field rule (`${gather.series.folderPath}`, `${gather.name}`); `.first`, `.last`, `.size`, `.N` and `.place` are gone (#1208).
- c90b8a2: One line runs a plugin or pipeline over the whole cohort, and `expect gather unpulled eq 0` says every member landed. `gather process` makes one feed whose root holds every member's landed folder (the cohort's own feed when it has one) and runs off that root; the name resolves as `/bin` resolves it, a series not pulled yet refuses by name, and it answers what the bare run would, so `R=$(gather process pl-dcm2niix-v1.0.2)` then `${R.outputPath}` (#1208).
- 243aafa: The recent-state pronouns are gone: a line names what it made with `A=$(…)`, never `${feed}`, `${run}` or `${query}`. `${feed}`, `${run}`, `${run.place}` and `${query}` were filled behind the line by whatever ran last, so one name meant different runs on different lines and a path that forgot to fill one left it stale (#1207); they and `session/recent.ts` are removed. `plugin run` is retired (a plugin runs by its name, where the session stands), and so are `pull --plugin` and `--pipeline` (pull lands data; a run goes over it). `chell -f` and `chell file` play the script as a manifest: each line shown, the first refused line stops it, and the exit is non-zero; `-e` changes nothing for a script. `help pronouns` is now `help variables` (#1208).
- 0a52833: A pipeline run answers every node it made, and a run's model says how it settled. `pipeline.scheduled` carries each node's instance, plugin, output folder and status, with the leaves nothing runs off, so `${P.instances.outputPath}` reaches every node and bare `${P}` is the nodes' ids; before, a pipeline passed as one plugin's run with the first id and an empty output path. `run.scheduled` gains `status`, CUBE's word as the run settled or `detached`. ARGUS lights a pipeline's feed as it lights a plugin's (#1208).

## 0.45.0

### Minor Changes

- 49501d4: Long jobs now outlive the command that starts them, and kill and wait reach them. A backend hands its jobs to the core's runner (`core/runner.ts`); each kind is mounted under `/proc/<source>` as a task source, its record and whole log kept under `$XDG_STATE_HOME/<backend>/jobs`. A job that was running when the session ended is picked up again through its source's `resume`, or marked failed saying why. Starting a job needs the `tasks` tier. `kill <task>` asks a job to stop and never forces it (a second `kill` says so); `wait [<task>]` follows a job's log to its end and takes its status, and Ctrl-C stops following, not the job. A job's end is announced to every surface.

### Patch Changes

- 0388f12: A stratus or null session greets cleanly: no red `motd` refusal on attach, and no ChRIS packages in its banner.

  The greeting asks `motd` with its output scoped away and prints only what `motd` answered, so a backend without one says nothing. A remote line's live output now goes to the sink it was sent from, not whichever is active when it arrives. The daemon's banner and attach answer name chili, salsa and cumin only for a ChRIS session (`versionsForBackend_of`).

- 01fcb59: A long listing stays aligned when an owner is long, such as a cloud user who is an e-mail address.

  `ls -l` pads the owner column to the widest owner in the listing, never narrower than ten. The text filters (`head tail wc sort uniq cut`) no longer say a system program "cannot read ChRIS files" in a session over another backend: they say the session's files, in their refusals and their help.

- 2a5a921: Following a task now starts with its last lines, as tail -f does, so nothing it said before you attached is lost. A backend can reach the runner and the command's cancellation through `@fnndsc/brasa/core`.
- Updated dependencies [01fcb59]
- Updated dependencies [49ccdfd]
- Updated dependencies [49501d4]
- Updated dependencies [14f8fc1]
- Updated dependencies [dcdc6cd]
  - @fnndsc/fond@0.5.1
  - @fnndsc/menu@0.28.0
  - @fnndsc/chili@3.7.15
  - @fnndsc/cumin@3.28.4

## 0.44.1

### Patch Changes

- 1e637f1: A backend's container kinds are folders to every tool.

  cd, ls of a file, and a read that fails on a folder decided folder-ness by naming item types (dir, vfs, job). A backend's listing look already says which of its kinds hold other items; the tools now ask it, through fond's itemType_isContainer and a container test the dispatcher is told at engine creation. A ChRIS session is unchanged: its jobs were already containers in its look. A stratus session can now cd into a compartment.

- Updated dependencies [1e637f1]
  - @fnndsc/fond@0.5.0
  - @fnndsc/chili@3.7.14
  - @fnndsc/cumin@3.28.3
  - @fnndsc/salsa@4.2.1

## 0.44.0

### Minor Changes

- 21649d1: A running command can show its surface a typed event, and trek shows its state at every Command: prompt.

  `OutputSink` gains `event_write(kind, data)`, the wire gains the `event` message (daemon to the command's origin surface, live only), and the ARGUS client hands events to its host. bsd-trek's `TrekTerminal` gains `state_show`, called with a deep copy of the whole game state before each command is asked for; the session's `trek` sends it as `games.trek.state`. The recorded C games replay unchanged; a terminal that only prints leaves `state_show` out. This is what a bridge that draws the game reads, instead of the printed scans.

### Patch Changes

- f42918a: trek takes the screen in ARGUS: a bridge drawn from the state the engine shows, played through its controls.

  `trek` typed at the transcript console opens the bridge over ARGUS and runs the session's `trek` as the operator's own command. The bridge reads the state the engine shows before each `Command:` prompt (a header of condition, ship, mission and position, the short- and long-range scans, the galaxy chart as the ship knows it, engineering) and answers the engine's questions one at a time from controls lit by the question: command pills, a course wheel, sliders for distance, warp factor, rest and phaser units, pills for choices, and a strip for the questions the engine asks on its own. The ship's log is the game's own words, read only. LEAVE BRIDGE (and Esc, which asks first) abandons the open question; the engine reads end of input and ends the game as the C does, and ARGUS comes back. bsd-trek gains `bsd-trek/host` (the state's types and the C's tables and codes, with no engine behind them, for a host that draws the game), its styling wrapper passes `state_show` through, and end of input is asked for once. The session's `trek` reads an abandoned question as end of input.

- Updated dependencies [f42918a]
- Updated dependencies [21649d1]
  - bsd-trek@0.4.0
  - @fnndsc/menu@0.27.0
  - @fnndsc/chili@3.7.13
  - @fnndsc/cumin@3.28.2

## 0.43.3

### Patch Changes

- 5c49254: trek shows its credits with `credits` in the game and `trek --credits`, and Ctrl-C ends a game cleanly.

  `credits` at the `Command:` prompt and `trek --credits` (in a terminal and in mise's session) name the game's authors as the C's own credits do, the TypeScript port by Rudolph Pienaar, and mise and ChRIS. The command is the port's, last in the command table, and takes no time. Ctrl-C in the `bsd-trek` command now ends the game at once with status 130, as the original's interrupt did, instead of a readline stack trace.

- Updated dependencies [5c49254]
  - bsd-trek@0.3.0

## 0.43.2

### Patch Changes

- 313d1f7: bsd-trek keeps the C's names for ported code and names everything the port added object_verb, all of it documented.

  Functions ported from NetBSD's C keep the C's names (`dowarp`, `getcodpar`), so the port reads side by side with its source; each JSDoc names the C function and file it came from. Code the port added follows the house `object_verb` style (`cli_run`, `dumpPath_get`, `trekArgs_parse`), and `lint:trek` refuses a name that is neither. Every function carries a JSDoc block, with explicit types and named interfaces throughout. `TrekTerminal`, the interface a host implements to run the game, renames its members to `text_write`, `question_ask` and `seconds_sleep`; brasa's `trek` builtin implements the new names. The game plays exactly as before: the eighteen games recorded from the C still replay byte for byte.

- Updated dependencies [313d1f7]
  - bsd-trek@0.2.0

## 0.43.1

### Patch Changes

- 2bbd262: The session's trek game now comes from bsd-trek, the same port published on its own for anyone to play in a terminal.

  The BSD trek(6) engine moved out of brasa into `packages/trek`, published as `bsd-trek` (`npx bsd-trek`). brasa's `trek` builtin is now the session's terminal and saved-game slot over that package, with the same flags and the same game; brasa no longer carries the trek NOTICE, which travels with `bsd-trek` as its BSD-3-Clause licence.

## 0.43.0

### Minor Changes

- 057ae8e: A pipe ends in wc, head, tail, sort, uniq or cut on every surface, ARGUS's terminal included: they run in the session.

  `find /proc/jobs -plugin pl-dylld | wc -l` failed in ARGUS: `wc` was a host program, and a browser runs none. The six are builtins now, with POSIX's common flags and meanings (`wc -lwcm`, `head`/`tail -n N`, `-N`, `head -n -N`, `tail -n +N`, `sort -rnfu -k N[,M] -t C`, `uniq -cdui`, `cut -f/-c LIST -d C -s`), reading what is piped in or ChRIS files named as operands. A flag they do not take goes to the system program, with the piped text, where the surface runs one, and is refused by name where it does not; `command sort` still asks for the system's. The daemon now says truly whether the acting surface can run a pipe segment (a chell can, a browser cannot, any surface under `--host-control pipes`), so grep and these filters answer in the kernel rather than handing text to a browser that refuses it.

### Patch Changes

- d6337c6: A folder made with mkdir -p is there at once for touch, ls and find, its new parents included.

  `mkdir -p a/b` makes `a` in the same CUBE step and says nothing of it, so a folder lookup kept as a miss for `a`, and the listings above it, still said it was absent: `touch a/x` answered "No such file or directory" and `find` saw nothing beneath. An invalidated folder now drops the misses kept for every folder above it, and `mkdir -p` forgets each listing above the new folder up to the first that already held its child. The smoke gains a `find` scenario: POSIX order and predicates on a scratch tree, and `/proc/jobs` judged whole from the index with no CUBE request.

- Updated dependencies [d6337c6]
  - @fnndsc/cumin@3.28.1

## 0.42.0

### Minor Changes

- 20cd854: The job index keeps which pipeline run made each job, and find asks it with -pipeline and -workflow, CUBE never asked.

  Each `/proc/jobs` job keeps its CUBE row's `pipeline_name` and `workflow_id` (a job run directly keeps null), saved in the checkpoint. Jobs restored from an older checkpoint are read again once, feed by feed on six lanes, behind the prompt. `find /proc/jobs -pipeline 'FreeSurfer*'`, `-pipeline ''` (a direct run) and `-workflow ID` answer from the index; a job whose run is not known yet is not judged, and `find` names how many on stderr instead of dropping them silently.

### Patch Changes

- Updated dependencies [20cd854]
  - @fnndsc/cumin@3.28.0
  - @fnndsc/salsa@4.2.0

## 0.41.0

### Minor Changes

- e9d9540: Questions about runs are now answered from the session's job index with find over /proc/jobs, asking CUBE nothing. -plugin and -status test what a job ran and how it ended, so find /proc/jobs -plugin pl-dylld -status finishedWithError lists every failed run. A mount can answer a whole subtree for find; /proc/jobs does.

### Patch Changes

- Updated dependencies [e9d9540]
  - @fnndsc/fond@0.4.0
  - @fnndsc/salsa@4.1.0
  - @fnndsc/chili@3.7.12
  - @fnndsc/cumin@3.27.20

## 0.40.0

### Minor Changes

- c7acb1b: A new find command walks the namespace through the listing cache and prints the paths its expression selects. Tests are -name, -iname, -path, -type and -newermt, bounded by -maxdepth and -mindepth, printed with -print or -print0, and joined by -o, ! and parentheses; a tree already seen is walked without asking CUBE. An unforced /proc/jobs roster check runs at most once a minute, and REFRESH still forces one.
- fb6813d: Any running command can now be stopped, with Ctrl-C or the console's new STOP capsule. A host process it started is killed, and a command that does not end when asked is abandoned after three seconds so the session is free again. A chell that disconnects stops its command, and Ctrl-C reaches a host program in the terminal.

### Patch Changes

- 5dadfdd: The terminal console's text is the old console's size again, and a new clear command empties the console. The terminal had taken the page's larger size because xterm measured it before the console's styles applied. clear empties the screen and scrollback in a terminal and the record in the transcript; Ctrl-L still clears the screen alone.
- Updated dependencies [c7acb1b]
- Updated dependencies [fb6813d]
  - @fnndsc/salsa@4.0.6
  - @fnndsc/menu@0.26.0
  - @fnndsc/chili@3.7.11
  - @fnndsc/cumin@3.27.19

## 0.39.0

### Minor Changes

- 66f1956: sl, cmatrix, rain, asciiquarium, tetris and snake play in the terminal they are typed in; --pane draws them in ARGUS's GAMES pane. The programs move to `@fnndsc/menu/games` so chell and ARGUS run the same ones; chell takes the screen (alternate screen, raw keys, the console's hues) and gives it back on q, Esc or Ctrl-C, and marks the console `playing` meanwhile. The transcript console, with no screen to play on, keeps the pane.

### Patch Changes

- 66f1956: A login whose token check gets no answer from CUBE asks once more before failing. If CUBE stays silent the session says CUBE did not answer, not that it refused the token.
- Updated dependencies [66f1956]
  - @fnndsc/menu@0.25.0
  - @fnndsc/chili@3.7.10
  - @fnndsc/cumin@3.27.17

## 0.38.2

### Patch Changes

- d26f22c: Listing /proc/jobs and entering a feed no longer wait on CUBE: the roster check runs behind the answer after 250 ms. A session booted from a door's token keeps its folder lookups memoised, as a password boot always did; a lookup that finds no folder (a shared feed's own path) is kept 15 seconds instead of asked again by every caller; `ls` reads a listing once; a parent's fresh listing answers whether a child is a folder; the PACS server list is kept a minute. The terminal console's text is the transcript's size again.
- Updated dependencies [d26f22c]
  - @fnndsc/salsa@4.0.4
  - @fnndsc/cumin@3.27.16

## 0.38.1

### Patch Changes

- Updated dependencies [90b7688]
- Updated dependencies [554fd24]
- Updated dependencies [90b7688]
- Updated dependencies [6bde343]
  - @fnndsc/menu@0.24.0
  - @fnndsc/salsa@4.0.3
  - @fnndsc/chili@3.7.9
  - @fnndsc/cumin@3.27.15

## 0.38.0

### Minor Changes

- 0746967: A command waiting on a question no longer freezes the session; other commands run until it is answered. While its question (or an editor) is open, other surfaces' commands run, and it takes its turn again when answered. Before, a trek waiting for a move, an `rm` waiting for "y" or a PACS confirm froze every pane verb and every other terminal until it was answered, or until an abandoned terminal was cleaned up. The daemon's queue is now a lane that a command gives up while it waits on a person and queues for again after the answer, resuming with its own routing. Brasa hands over each command's own state at the same two points: its exit code, a pipe's untaken input, a `play` manifest's depth, the recorder's mute and the Ctrl-C target. Each top-level line keeps its own error stack. Commands that ask now fix their targets before asking, so a `cd` from another surface cannot redirect the answer. `rm` resolves every operand first, `mv` and `cp` fix their sources, and a relative destination or PACS export path lands where the session stood when it asked (#1128).
- 2ddbd41: New `trek` command: the 1976 Berkeley space war game, played by question in the console or a terminal. It is a line-by-line port of NetBSD's trek(6). Fixed seeds give the same transcript as the original C built with glibc's random(); the tests replay 18 recorded games byte for byte. The short and long range scans show glyphs and colours, and `--classic` shows them as originally printed. `-f`, `-s` and `--seed N` are also accepted. `dump` keeps the game in the session and a `restart` length brings it back. One change from the original: when a starbase is caught in a nova, the C passed sector coordinates to killb() as a quadrant's and read past the galaxy array; the port destroys the base in the current quadrant instead. The UC Berkeley licence and the original credits are in brasa's NOTICE.

### Patch Changes

- 1a2a0d0: An open question shows across the session: `? N WAITING` on the ARGUS status strip, and `? N waiting` in chell's prompt. The daemon counts the questions open on every surface: they ride the heartbeat's lane (which surface asked what, and for how long) and every prompt context. ARGUS names each one in the strip's title and adds an ASKING row to the lane instrument; `who` says what each surface is waiting on. A question no longer freezes the session, so this is how a game paused in another tab, or a confirm left in a terminal, is not forgotten (#1128).
- Updated dependencies [c73c81b]
- Updated dependencies [1a2a0d0]
  - @fnndsc/menu@0.23.0
  - @fnndsc/chili@3.7.8
  - @fnndsc/cumin@3.27.14

## 0.37.1

### Patch Changes

- 9dc62f7: Help now has a POSIX page for the commands that mirror Unix utilities. `help POSIX` groups them as Files, Text, System and Shell, each with a line on how chell's version differs: `ls` lists ChRIS's filesystem rather than this machine's, and `grep` also filters numbered listings. The help table of contents points to it.

## 0.37.0

### Minor Changes

- a44990a: Help is now a short table of contents instead of one long list. `help` shows each section (Navigation, Files, PACS, Workflows, Shell…) with what it is for, its size and a few commands, and `help PACS` lists that section's commands. The shell's features have their own pages (`help pipes`, `help handles`, `help pronouns`). New: `apropos <word>` (also `man -k`) finds commands by a word in their name or description, and `man <command>` shows a command's page.

## 0.36.0

### Minor Changes

- a55f8db: You can now see which number to type. A PACS answer, `query --table`, `gather list` and `ls -l` print each row's handle (`@PAT1`, `@STD3`, `@SER12`, `@DIR4`) beside it, short and aligned, and end with a footer saying what is numbered (`numbered: @PAT1, @STD1-20, @SER1-299`). What is printed is what `gather add @SER12` expands to. `help pronouns` explains the `${…}` pronouns, and a handle that names nothing in the current listing says what the listing holds.
- 739b2c5: You can narrow a PACS answer to the series you want with grep. `query … | grep -i t1 | grep -vi gadavist` keeps the matching series with their study and patient, and every row keeps the handle it had, so `@SER241` still means the same series. What grep keeps becomes the listing `@SER` and `${listing}` refer to, so `| gather add` takes exactly that. It works on `ls` and `gather list` too, and with nothing piped it filters the last listing. grep takes its usual flags (-i -v -w -E -F -c -e); on plain text, or with any other flag, it is the system grep.
- 79ac4a4: A numbered listing now travels through a pipe, so `query … | gather add` gathers what the query found. Between builtins the listing goes along with the text; a pipe's last listing becomes the one `@SER3` names; and `${listing}` stands for that listing's series, files or folders. `gather add` or `gather remove` with nothing to act on now says what it takes instead of failing quietly.

### Patch Changes

- e6b6ed8: Run the system's own program instead of chell's with `command`, as in any POSIX shell. `query … | command grep -i t1` is plain text grep with no listing handling, and `command -v grep` answers as the host shell does.
- b0b458b: Help now lists every command you can run. It listed 70 of them from a hand-kept list, missing `play`, `query`, `gather`, `pull`, `record`, `expect`, `url`, `version`, the job and instance aliases and more. Each command now declares its own group, including a new Workflows & Cohorts group, and a check fails the build if a new command has none.
- 580af08: A query now warns when the PACS ignores part of what you asked. PACSDCM answers `SeriesDescription` and `StudyDescription` as if they were not there, so `query PatientID:…,SeriesDescription:*T1*` returns every series; the query still runs as asked, and one line points at the grep that narrows it (`… | grep -i -e 'T1'`). Each server's ignored keys can be set in `~/.config/mise/pacs.json`.

## 0.35.2

### Patch Changes

- 9065319: A feed shared with you is marked NEW until you open it, across logins (#1065). RUNS leads with a NEW SINCE YOUR LAST VISIT block, each row marked with who shared it, and the bar counts them. Opening a feed takes its mark off, and CLEAR NEW takes them all. `proc feeds --new` lists them and `proc seen` clears them. Your own feeds and public feeds are never marked.
- Updated dependencies [9065319]
  - @fnndsc/cumin@3.27.13
  - @fnndsc/salsa@4.0.2
  - @fnndsc/menu@0.22.2

## 0.35.1

### Patch Changes

- e29bf91: A feed shared to you is seen on your next look at the roster, not after the next ten-minute walk (#1058). The roster's delta reads each collection's newest page and walks whole when the total moved, so a share, an unshare or a deletion lands on the visit that follows it. `proc feeds <q>` matches a feed's title, its `feed_N` name and its id; a bare id the roster lacks is asked of CUBE live and adopted, or refused with why (not shared with you, or shared to a group you are not in). `ls /proc/jobs/feed_N` asks the same way. In ARGUS a RUNS filter that names a feed by id and matches nothing asks the session too: the row arrives marked, or the field says what CUBE answered. The roster frame gains REFRESH (`proc feeds --fresh`), and the bar says `CHECKING CUBE FOR THE FEED LIST…` while any walk runs and `FEED LIST CURRENT · n NEW` when it lands.
- a0f0160: Jump to a feed or a node by its number (#1061). `proc jump 639204` goes to the node, `proc jump feed_4389` to the feed, asking CUBE for anything shared since the roster was walked. A bare number that is both a feed and a node is never guessed: chell names both, and RUNS asks which. RUNS gains JUMP TO on the roster frame: it asks for the number, enters the feed, and selects the node once the graph is drawn, without moving the console's working directory.
- 1b93202: A large file downloads, and a file in a feed shared with you downloads (#1061). A file stream has no 30 s deadline any more: CUBE held a 3.7 GB DICOM's first byte for up to a minute, and the old deadline killed every attempt. A watchdog fails a transfer only after two silent minutes, and says so. A file in a colleague's shared feed is read through CUBE's file browser, which serves it where `/userfiles/` answers 403. `download` names the kernel's reason (a stall, a refusal, a file too large to read whole) instead of "Failed to download file", and a file over 256 MB is never read whole into memory after a failed stream. ARGUS's DOWNLOAD streams through the daemon with its length in the header, so the browser draws its own progress and the daemon holds nothing whole.
- b95fedf: A link opens ARGUS where it points (#1061). `url [path]` in chell prints the door's address with the path as its fragment, LINK on a RUNS graph copies one for the selected node or the feed, and LINK on a FILES row for that folder or file. Opening the link lands there once: a feed or node in RUNS, anything else in FILES, without moving the session's working directory. The door comes from `CHELL_DOOR`; without it `url` prints the fragment and says so.
- Updated dependencies [e29bf91]
- Updated dependencies [a0f0160]
- Updated dependencies [1b93202]
  - @fnndsc/cumin@3.27.12
  - @fnndsc/salsa@4.0.1
  - @fnndsc/menu@0.22.1
  - @fnndsc/orrery@0.6.1
  - @fnndsc/chili@3.7.7

## 0.35.0

### Minor Changes

- e1215ef: The core shell runs with no ChRIS package at all: `@fnndsc/brasa/core` boots over the null backend (#1001). `nullBackend_make` gives a session with no commands of its own, a filesystem held in memory, and a home at `/home/<user>`. The `@fnndsc/brasa/core` entry installs no backend; a host passes `engine_create` the one it runs over. CI proves it on every change (`npm run test:core-boot`): plain Node boots the core over the null backend with cumin, salsa and chili refused. It then runs navigation, the file tools, pipes, redirection and help, and fails if anything asked for a ChRIS package, caught or not.
- 0ac1bee: Nothing changes at the prompt: each command group brings its own help, and no backend can replace a core command (#981). The ChRIS commands' help (74 pages, and the resource contract they share) moves to `chris/help.ts` and registers with the ChRIS commands; the core's stays in `builtins/help.ts`. `/usr/bin` and command completion offer only verbs the session can run, as `help` does. `commands_register(group, 'backend')` refuses a group that names a core command; the package entry registers ChRIS that way. The hand-kept `command-keys.ts` goes, and with it the `COMMAND_HANDLERS_KEYS` export of brasa and chell; the registry answers instead.
- 6752575: Nothing changes at the prompt: a backend brings its long-running steps as tasks, shown under `/proc/<source>` (#983). menu's `Task` has an id, a label, a state (`queued`, `running`, `done`, `failed`, `cancelled`), progress, start and end times and a log tail. A backend's `tasks` lists its sources; one that brings no mount of its own is shown by the core as a folder per task and a file per field (label, state, progress, started, ended, log), its whole log where the source keeps one. The null backend takes task sources too, and CI's core boot lists and reads a fake one. ChRIS's `/proc/jobs` is unchanged; it becomes a source in the next step.
- 60cb7f8: Nothing changes in chell or ARGUS: any backend's task can be watched, and ChRIS's feeds are a task source (#983). The core watches a task the backend leaves to it, `/proc/<source>/<id>`, asking its source until the task is over and telling every surface `live`, `settled`, or `stale` when the source cannot answer. The backend's own watch answers first, so ChRIS's feed watch is unchanged. ChRIS's feeds are the `jobs` source: each feed a task named as `/proc/jobs` names it, standing where its jobs do, with its jobs as progress. `/proc/jobs` stays its own mount. CI's core boot watches a fake task settle.

### Patch Changes

- 43000d3: Nothing changes at the prompt: a daemon's berth name comes from its backend's account of who the session is (#982). The descriptor gains `session.identity_get()`, which returns a `SessionIdentity` (`user`, `where`, `connected`). For ChRIS that is the CUBE user at the CUBE URL, or `disconnected@no-cube` with no login, so every berth name, key and attach hint is the same as before. Each backend names its own disconnected session, so two backends never share one. calypso's launch reads the identity there and no longer imports cumin. chell keeps its folder, query and job checkpoints under the same name, through the backend. `identity_forSession` and `DISCONNECTED_IDENTITY` stay exported from calypso.
- e1085af: Nothing changes at the prompt: what it shows and what the daemon heartbeats come from the backend (#982). The descriptor gains `prompt` and `telemetry`, both in the wire's existing shapes (`PromptContext`, and `BackendTelemetry` with jobs, feeds, CUBE pace and job state). The ChRIS backend supplies its session prompt context and /proc snapshot; those files (`promptContext.ts`, `jobsState.ts`) move to `chris/` and are exported as before. calypso's launch takes both from the backend and imports neither. A backend without them gets no promptline or heartbeat providers. `lint:core-deps` drops to 14.
- 27ce9b8: Nothing changes at the prompt: ChRIS's `${name}` references and PAT, STD and SER indexes move to its backend (#982). They are `${feed}`, `${run}`, `${query}` and `${gather}`. The core answers `${cwd}` and numbers files and folders (`@FIL`, `@DIR`). The descriptor gains `references`, `answerKinds` and `verbTakes`, and ChRIS supplies its four references, its three kinds and what its verbs take (`chris/references.ts`). A verb handed the wrong kind still refuses by name, in the same words. The syntax hint still reads `@SER3, @STD1, @FIL2, @DIR4`. `AnswerKind` is an open string.
- 7e2fc05: Nothing changes at the prompt: the session asks its backend for its home and working directory (#982). `core/backend.ts` holds the backend descriptor (`Backend`, `backend_install`, `backend_get`); `chris/backend.ts` is the ChRIS one, keeping the working directory in the identity's context as before and the CUBE connection reachable as `session.connection`. `engine_create` takes an optional backend; the package entry installs ChRIS, so every host boots as it did. The saved-session and token connect functions move to `chris/connect.ts` and are exported as before. `lint:core-deps` also counts core files that import the ChRIS backend's `chris/` folder and drops to 16.
- 4431568: Nothing changes at the prompt: unknown words, `sudo`, the job watch and file reads go through the backend (#1001). The descriptor gains `fallback` (`claim`, `unknown`, `help`), `elevate`, `watch`, `files` and `debug_get`. ChRIS supplies them from `chris/`, keeping each of today's orders: a versioned plugin name, `/bin` plugins and pipelines, then chili. The core says `command not found`, `sudo` refuses when the backend has no administrator, and a session with no files refuses a surface's read. cumin's output port is wired by the ChRIS backend. `lint:core-deps` drops from 9 to 6.
- d379168: Nothing changes at the prompt: why a pipe never runs a bare plugin name is written down (#981). Running a /bin plugin starts a CUBE job; typed at the prompt it does, inside a pipe or a redirect it does not, so a pipeline of words never starts a job as a side effect.
- 11853c6: Reading a folder as a file says `Is a directory`, on every mount (#1026). A home folder had answered with CUBE's words for a missing file, `/proc` and `~` with "No files found in directory", `/bin` with "Unknown /bin entry", and `/proc/jobs` with nothing at all and exit 0. The dispatcher now answers EISDIR for any failed read of a path its parent lists as a folder. /proc reads no folder or unknown name as empty text. The native mount keeps CUBE's words only for a path that is missing. cat names the path once.
- 9b48f7c: Nothing changes at the prompt: the engine's commands register in two groups, the core ones and the ChRIS ones (#981). `core/coreCommands.ts` holds the commands written over the filesystem and the session (cd, ls, cat, cp, mv, rm, help, exit, the toys and the rest); `chris/chrisCommands.ts` holds everything that speaks to CUBE (identity, feeds, plugins, pacs, upload, download, store and the rest). dispatch registers the core group and the package entry registers the ChRIS one; an explicit order (`core/commandOrder.ts`) keeps every listing, the /bin builtins and tab completion in the order they had. brasa now depends on `@fnndsc/fond` for the item type. `npm run lint:core-deps` counts brasa core files that import cumin, salsa or chili (18) and fails if that number moves without its baseline. The recorded command surface is unchanged and matches.
- 90ede03: Nothing changes for chell, ARGUS or porter users: help now comes from the command registry. `help`, the /bin builtin list and command completion read the help each command registers; every page and entry is exactly as before.
- 3bc7a27: Nothing changes for chell, ARGUS or porter users: the engine answers commands through a command registry. Every name, handler, help page and /bin entry is exactly as before, proven against the recorded command surface.
- 11853c6: Completion at the root no longer offers `/pacs`, which does not exist (#1023). PACS lives at `/net/pacs`; the root offers `/bin` and `/usr` beside what `/` lists.
- 987f766: Nothing changes at the prompt: cat reads through the backend's filesystem, not chili (#1001). Text goes through the filesystem's `read` and binary files through `readBinary`. A refusal prints the mount's own words, so CUBE's "File not found …" and each mount's refusal read as before. Highlighting, binary detection and the `/etc/group` progress are unchanged.
- ebd7b3e: Nothing changes at the prompt: `cp` goes through the backend's filesystem (#1001). Into a folder the destination names, the copy keeps its name, decided by the core as mv decides it. The mount's refusal is said once, after one `cp:`. The memory mount refuses a copy of a file onto a folder (EISDIR) or of a folder onto a file (ENOTDIR), as a disk does.
- e32770c: Nothing changes at the prompt: listings, globbing, completion and `~` go through the backend's filesystem (#1001). The descriptor gains `vfs` and `completion`. `vfs` holds a fond dispatcher with the backend's mounts, a listing cache, which paths the cache may hold, long-row annotations, unread-link notes and physical paths for globbing. `completion` adds command words, `--options` and the names completed at `/`. The core adds `/usr` and beneath it to the backend's dispatcher. A backend without a filesystem gets the core's own dispatcher and no cache. `/bin` is the ChRIS backend's mount, added as it starts, ahead of `/usr` as before. Globbing and path resolution move into the core. The universe layout moves into `chris/`. `lint:core-deps` drops from 6 to 0.
- 27f3021: Nothing changes at the prompt: the engine reads its generic pieces from their own homes, not from cumin (#1001). menu gains the envelope helpers `envelope_ok`, `envelope_error` and `envelope_isOk`, beside the `CommandEnvelope` they make; cumin keeps its own for its callers. brasa reads `Result` and the error stack from fond and the envelope from menu. The error stack is still the one instance cumin shares. The core command group imports its builtins module by module rather than through the builtins barrel. `lint:core-deps` drops from 14 to 9.
- 423971a: Making folders with parents never puts one over a file or beneath one, and missing parents no longer fail the command. `mkdir -p a/b/c` had made the folders and still exited 1, because looking up a parent that was not there left its complaint on the error stack. `mkdir` now goes through the backend's filesystem. fond's mounts gain `mkdirTree` (a folder and its parents in one step, as CUBE makes them), and the contract holds it: EEXIST for anything already there, ENOTDIR beneath a file. A mount without `mkdirTree` is walked one parent at a time. Under `-p`, something already there counts as done only when it is a folder; a file is `File exists`. salsa's `folderPath_holder` names the nearest thing holding a path or a parent of it. The fs views (`mkdir_render` and its kin) live in fond.
- d3f1b1d: Nothing changes at the prompt: pwd, cd and ls go through the backend's filesystem, not CUBE directly (#1001). The backend's filesystem gains:

  - `folder_enter`: how `cd` enters a folder outside the mounts (ChRIS: asks CUBE for it, mapping links and showing its debugging trace as before).
  - `structural`: the paths that are always folders.
  - `segment_title`: what `pwd --title` shows for a segment (ChRIS: a feed's or plugin's name).

  The listing cache gains `cache_invalidate` and `cache_invalidateTree`. A backend without `folder_enter` treats a path that lists as a folder.

- b5ae25d: Nothing changes at the prompt: commands that read CUBE themselves register with the ChRIS backend (#1001). `tree`, `du`, `edit`, `file`, `xxd`, `strings`, `sha256sum`, `md5sum`, `record`, `play`, `expect` and `motd` join the ChRIS group. Listings, help and completion keep their order. `who` asks the backend for the session's user (`BackendSession.user_get`). `debug` toggles the backend's debugging (`debug_get` returning null before it can say, and `debug_set`), and a backend without one refuses it by name. The lab's `ping` and `chrisfetch` move to `builtins/games/chrislab.ts`. The core group now reaches ChRIS only through the ten file commands.
- 77a914f: A refused removal names what the path is, where it had said `No such file or directory`. `rmdir` of a file says `Not a directory`, `rm /proc/jobs` says `Read-only file system`, and `rm /bin` says `virtual /bin directory`. `rm` and `rmdir` go through the backend's filesystem (#1001). rm removes a file or link with the mount's `rm`, and a folder only with `-r`: with `rmTree` where the mount offers it, else entry by entry, deepest first. Nothing there is fine under `-f`. A projection's path is its mount's to remove or refuse. The /proc/tags hints (setfattr untags a feed, rmdir deletes a tag) and the /bin refusal move into those mounts, so the core names neither. rmdir asks the mount's `rmdir`. The ChRIS-only folder probe (`folderExists.ts`) goes.
- 3175b3d: Writing into a missing folder says `No such file or directory`, as on a disk, rather than making the folders. `touch` and `mv` go through the backend's filesystem (#1001). touch writes with the mount's `write`. A file already there is kept as it is when no content is given, and a projected file takes text only. ARGUS makes `~/gather` before it writes the cohort there, and waits for it. mv moves into a folder the destination names, keeping the source's name. It says a missing source by name and passes the mount's refusal on once (CUBE cannot overwrite). The shared helpers (`entry_at`, `folderTree_make`) live in `builtins/fs/entries.ts`. The native mount drains what looking up a missing parent said, as `pathHolders_find` does.
- e1215ef: Help lists only the commands this session can run. A verb the session lacks has no page; `help <name>` asks the backend for anything else (ChRIS answers for a plugin or pipeline version), else says there is no help. Under ChRIS the page is unchanged; `sudo` is listed where the backend can elevate.
- a12c6fc: Nothing changes at the prompt: `ls` renders through fond, not chili, in every listing exactly as before (#1001). fond gains `grid_render`, `long_render`, `size_format` and `listingItems_sort`, and a listing look: the core's kinds (file, folder, link, mount) plus a backend's, each with its long-view mark, and how a name is coloured. Its one dependency is `chalk`. chili's `ls` views wrap fond with the ChRIS look: plugins, pipelines, and jobs with their status column, coloured by the colour configuration. brasa's listings render with the installed backend's look, or plainly when it has none. `VFSItem` gains `tags`.
- 9173d2c: A file you name to `ls` is listed, as POSIX ls lists it, instead of "Cannot list … No such file or directory". `ls ~/notes.txt` works. It used to work only while the file's folder happened to be cached. A path that won't list as a folder is now looked up in its parent, and an entry that isn't a folder is the answer. A missing file or folder still fails as before.
- 11853c6: Listing afresh lists the path named, and ls refuses an option it does not have by name (#1024, #1025). `--refresh` and `--reverse` are switches, so the word after one had been taken as its value and the working folder listed instead. `ls -R` had been ignored without a word; it now answers `ls: invalid option -- 'R'`, as does any other option ls lacks. A `--sort` value outside name, size, date and owner is refused rather than ignored. `-a` and `-A` are taken: nothing in a listing is hidden.
- 149adbf: Listing several paths says which entries belong where (#1028). Files come first, together, then each folder under its own `name:` header (the name as typed), with a blank line between, as a shell gives them. One operand, or `-d`, has no header.
- fb31bef: A folder and a file never share one path. CUBE lets them, and removing the folder then damages the file's record so every listing of the parent fails (CUBE #732). `mkdir` over a file answers `mkdir: cannot create directory 'X': File exists`, and beneath a file `Not a directory`. `touch` or a write over a folder answers `Is a directory`. `mv` onto anything that already holds the destination refuses (`Destination exists`). `cp -r` skips a file whose name a folder holds, with a warning. `rm` refuses a path that a folder and a file already share, removing neither. salsa's `pathHolders_find` names what holds a path.
- 9116e97: Internal: the calypso command can host the null backend for a test, with no ChRIS package loaded (#985). `CALYPSO_TEST_BACKENDS=1 calypso --backend null` hosts a session with no commands of its own and a filesystem in memory; without the variable the switch is refused. calypso's daemon code imports brasa's core entry, which now carries the version report and the logo. The calypso command loads brasa's ChRIS root only when it hosts ChRIS. A surface attached to the null daemon is told `backend: 'null'`.
- ec26525: A redirected listing numbers its rows: after `ls ~ > listing.txt`, `cd @DIR1` goes where it would after `ls ~`. The rows go to the file and the terminal shows the usual "from: ls ~ · 25 rows" readout, so an index never refers to rows nobody was told about. Pipes are unchanged: what a pipe shows is filtered, so its rows are not numbered.
- 11853c6: A bare `sudo` says its usage (#1022). sudo's own refusals (no command, a nested sudo, no administrator to become, empty credentials) were returned but never written, so `sudo` alone printed nothing and exited 1. The nested command still writes its own output, once.
- 0fe1e18: A missing path is now said to be missing by `tree`, `du` and `ls -d`, and unknown options are refused by name. `tree ~/nowhere` says `No such file or directory` instead of drawing an empty tree, and `tree -L 1` or `tree --bogus` are refused by name. `--bogus` used to scan the whole home folder. `du ~/nowhere` refuses instead of printing 0. `du -d 1` and `-dN` take the depth instead of measuring a folder named `1`. `ls -d ~/nowhere` refuses instead of showing `nowhere/`. An empty folder's tree shows the folder. `ls -d /proc/jobs` no longer exits 1.
- e1215ef: Listing `/usr` exits 0, and `cat` ends a file with its own newline (#1032, #1033). A folder holding only mounts had listed them and still failed, because the store's "nothing here" was left on the error stack. cat had added a newline to every file, so one ending in a newline printed a blank line after it and `cat f > out` wrote a longer file; it now adds one only to a file without.
- 1681476: A failed copy says why without the stack's internal markers (no more `cp: [StaticVfsProvider.cp …] | cp: …`). Underneath, every filesystem operation answers with a reason (#1001). fond adds the filesystem contract: `VfsErrno`, `VfsOutcome` and `vfsRefusal_text`, which keeps the shell's existing wording for each refusal. Mount operations (read, readBinary, write, mkdir, rmdir, rename, cp, and the new rm and rmTree) return an outcome instead of a boolean or `Result`. The dispatcher asks the fallback too, through its path resolver. fond also adds `MemoryVfsProvider`, a complete in-memory mount, and `VFS_CONTRACT`, the cases any mount must pass. salsa's mounts and dispatcher return outcomes, so its callers change (a major bump). A mount's own message travels as the reason, so every refusal reads as before. proc's unreachable `rm` becomes `feedJobs_cancel`.
- Updated dependencies [183aa7d]
- Updated dependencies [11853c6]
- Updated dependencies [ebd7b3e]
- Updated dependencies [27f3021]
- Updated dependencies [423971a]
- Updated dependencies [77a914f]
- Updated dependencies [3175b3d]
- Updated dependencies [a12c6fc]
- Updated dependencies [fb31bef]
- Updated dependencies [f6171f7]
- Updated dependencies [6752575]
- Updated dependencies [e1215ef]
- Updated dependencies [1681476]
  - @fnndsc/menu@0.22.0
  - @fnndsc/fond@0.3.0
  - @fnndsc/salsa@4.0.0
  - @fnndsc/chili@3.7.6
  - @fnndsc/cumin@3.27.11

## 0.34.0

### Minor Changes

- 8d15909: Nothing changes for chell, ARGUS or porter users: the engine's output and surface contract now lives in menu. `OutputSink`, `Surface` and their companions are served as `@fnndsc/menu/surface`; brasa re-exports them, and the engine installs its own sink and surface. `BrasaEngine` gains required `sink_install` and `surface_install`, so code that implements it must add both.

### Patch Changes

- Updated dependencies [8d15909]
  - @fnndsc/menu@0.21.0
  - @fnndsc/chili@3.7.5
  - @fnndsc/cumin@3.27.10

## 0.33.4

### Patch Changes

- 5bb17f6: Nothing changes for chell, ARGUS or porter users: a listing entry's shape now belongs to menu, with an open type. `ListingItem` and `listingItemSchema` are menu's, so a backend can list its own kinds beside `dir`, `file`, `link` and `vfs`; fond's `VFSItem.type` opens the same way, and chili re-exports the type.
- Updated dependencies [e1deb53]
- Updated dependencies [5bb17f6]
  - @fnndsc/salsa@3.21.2
  - @fnndsc/menu@0.20.0
  - @fnndsc/chili@3.7.4
  - @fnndsc/cumin@3.27.9

## 0.33.3

### Patch Changes

- 22703a0: A PACS request CUBE refuses now says so and names the pacs_users group, instead of `pacs list` reporting no servers. `pacs list`, `pacs query` and a cohort query whose every question was refused add who grants PACS access; `group adduser` notes that a CUBE taking its groups from a directory (Authentik, LDAP) undoes the add at the user's next login, and the sudo hint now recognises CUBE's "You do not have permission" wording.
- Updated dependencies [f9244ad]
  - @fnndsc/orrery@0.6.0

## 0.33.2

### Patch Changes

- Updated dependencies [bd0af06]
  - @fnndsc/orrery@0.5.0

## 0.33.1

### Patch Changes

- Updated dependencies [c5e033d]
- Updated dependencies [71fe8a5]
- Updated dependencies [de04249]
  - @fnndsc/orrery@0.4.0

## 0.33.0

### Minor Changes

- 5a0eef5: The session can say what the installed releases changed. `notes` lists the newest release — one row per change, the package named — and `notes --since N|DATE`, `--long` and `--all` reach further; `help notes` is the same; `/usr/share/doc/NEWS` holds every release. The notes are read from the packages installed where the session runs, so they describe the code that is running.

### Patch Changes

- Updated dependencies [5a0eef5]
  - @fnndsc/menu@0.19.0
  - @fnndsc/cumin@3.27.5

## 0.32.1

### Patch Changes

- 5b64328: Bare `help` has a "Games and utilities" group: fortune, cal, weather, motd, and a `help games` row saying how many more small tools and games the /usr/games shelf holds (the count read from the shelf). General keeps help, date, exit and `!`. And `sl` flies the Enterprise: the Constitution-class refit side view from the Star Trek ASCII Art blog (re-use granted with attribution, kept in the source).

## 0.32.0

### Minor Changes

- 6901a81: The games shelf (#892): `help games` lists `/usr/games` by category and `ls /usr/games` walks it; the text toys (cowsay with the ChRIS brain, cowthink, figlet, banner, lolcat, rev, tac, yes, seq, factor, primes, shuf, roll, rot13, morse, calc, units), the lab's own (wtf, chrisfetch, who, uptime, ping, file, xxd, strings, sha256sum, md5sum, qr, say), time and sky (pom, stardate, ddate, sunrise; the chimes timer, leave, stopwatch on the ambient channel), the showpieces (sl, cmatrix, rain, asciiquarium) and the games (tetris, snake on a surface with a canvas; quiz, hangman, 2048 by question anywhere). A pipe segment naming a builtin now runs in the kernel, so `fortune | cowsay` works in a browser; a segment the surface cannot run is refused in words.

## 0.31.5

### Patch Changes

- 73c0087: A PACS series that arrives is no longer shown as ERROR. The retrieve watch always asks CUBE before it gives up on a series (with no retries, the default, it never did), a series not seen to finish and not yet in CUBE is UNCONFIRMED with its reason rather than ERROR, and the watch waits a minute (not fifteen seconds) for a PACS slow to begin. Progress messages carry an optional `reason`, shown on the ARGUS badge and in pull's summary. In ARGUS a fresh answer finding a series home in CUBE replaces a pull that ended badly, and a pull waiting on its first file paces again instead of drawing a still empty bar. After twenty seconds of silence a pull checks CUBE and then asks whether to keep waiting (a surface that cannot be asked waits a minute). ARGUS runs the PACS pane's pull and query as the operator's own acts rather than instrument traffic, so they can ask.
- Updated dependencies [73c0087]
  - @fnndsc/salsa@3.21.1
  - @fnndsc/menu@0.18.0
  - @fnndsc/cumin@3.27.4

## 0.31.4

### Patch Changes

- Updated dependencies [baec61d]
  - @fnndsc/orrery@0.3.0

## 0.31.3

### Patch Changes

- ff80b59: A shared feed's `data` opens again. Listing a /proc link into a feed another user owns walked the owner's home asking for links, and that refusal, a side question, marked the whole `ls` an error though its listing came. chili's path walk no longer leaves its link probe's refusal on the error stack; it remembers the parent it could not read instead. When a listing then fails, `ls` says so after the reason (`ls: links in '/home/<owner>' could not be read; the path was walked as written`), because a link there, unseen, may be why the path was not found; when the listing succeeds nothing is said. ARGUS's files panel draws a listing the kernel sent even when the command is marked an error, and a refused press reads every line the kernel said, so the note reaches the bar too.
- Updated dependencies [ff80b59]
  - @fnndsc/chili@3.7.1

## 0.31.2

### Patch Changes

- Updated dependencies [51315ec]
- Updated dependencies [33e4f1d]
- Updated dependencies [fe4b6b4]
- Updated dependencies [2d26368]
  - @fnndsc/menu@0.17.0
  - @fnndsc/cumin@3.27.2

## 0.31.1

### Patch Changes

- Updated dependencies [685ed59]
  - @fnndsc/menu@0.16.0
  - @fnndsc/cumin@3.27.1

## 0.31.0

### Minor Changes

- c1cf57e: An edit crosses the wire to a browser (#831, slice 2). The daemon's `edit` request now names the file being edited (`path`), and a surface may answer `opened`: it took the file into an editor that stays open, so the command saves nothing and says `(opened in the editor)`; each save made in that editor will run as its own command line. The argus client hands an edit to a host editor hook and answers at once that it opened, or refuses in words when it has none (the hook is installed by the editor pane, slice 3). `feed note edit N` is now `edit /proc/jobs/feed_N/note`: a terminal's editor and a browser's pane open the same text and save it the same way, and the title is set with `feed note N --title`.
- 1c8b92d: A feed's name and sharing, whole, in the kernel (#853, slice 1). `/proc/jobs/feed_N/title` is writable: its first line renames the feed (`touch --withContents=`, `edit`), and the roster says so at once. `setfacl` speaks every entry CUBE has: `-m u:<user>:r`, `-m g:<group>:r`, `-m o::r` (public) and `-m o::-` (private again); `-x u:<user>` and `-x g:<group>` withdraw a grant (a feed that held none is said). `chmod o+r` / `o-r` is the other entry spelled as a mode. `getfacl` shows users, groups and `other::`. A feed is also named by `/proc/jobs/feed_N`. `feeds share` is retired and refuses by name; SHARE's question no longer says a grant is permanent; the access and tag verbs get a help category. cumin gains `feedAccess_read`, `feedShare_group`, `feedShare_revoke` and `feed_rename`.
- e20fb09: A feed's note is a file (#831, slice 1b): `/proc/jobs/feed_N/note` lists beside `status` and `title`, `cat` reads it and `touch --withContents` writes it whole (its title stands), and `edit /proc/jobs/feed_N/note` opens it in the surface's editor and saves it back through the projection — a projected file is never uploaded into CUBE's store. `feed note edit` now edits through the surface's editor seam (`localEdit`) instead of spawning `$EDITOR` itself, so a browser surface can offer its own editor; a surface without one refuses by name. Fixed on the way: an empty `# Title:` line no longer takes the note's first line as its title.
- ddbd551: A feed's tags are kernel-covered (#831, slice 1a): cumin's `feedTags_list`, `feedTag_add` (the user's tag of that name, made if missing; idempotent) and `feedTag_remove` (the tagging goes, the tag stays); brasa speaks them as an extended attribute — `getfattr feed_12` dumps them, `setfattr -n tag -v urgent feed_12` hangs one, `setfattr -x tag -v urgent feed_12` takes it off, `setfattr -x tag feed_12` takes every tag off. A feed is named by id, feed_N, a /feeds/ path or /proc/jobs/feed_N; another attribute or flag is refused by name.
- 32e3919: `ls -l` shows a feed's tags (#831, slice 1c): a long listing that holds feeds (`feed_N` rows, as in `/proc/jobs` or `~/feeds`) prints each feed's tags as `#tags` after its title. The tags come from one map for the whole listing — the user's tags, then each tag's feeds — so a thousand feeds cost as many reads as the user has tags, never one per feed; the map is kept a minute and forgotten whenever a tag is added or removed here. A listing with no feed in it reads nothing.
- 59399fe: Tags are a vocabulary of folders under `/proc/tags` (#831, slice 4a). `ls /proc/tags` lists your tags (an unworn one too); `ls /proc/tags/<tag>` lists the feeds wearing it as links to `/proc/jobs/feed_N`, and `cd` through one lands in the feed. `mkdir /proc/tags/<name>` makes a tag, `rmdir` deletes one no feed wears ("Directory not empty" otherwise), and `mv` renames one. `setfattr -n tag -v <name>` no longer makes a tag: naming one that does not exist is an error naming the cure (`mkdir /proc/tags/<name>`). `rm` under `/proc/tags` is refused and names the verb that does the job. New builtin `rmdir` (empty folders only, as on Linux, on the store and in projections); `mkdir` and `mv` route a projection's paths to it, and a projection that makes or renames nothing refuses by name ("Read-only file system", "Invalid cross-device link"). The old read-only `/tags` projection is retired. cumin gains `tags_index`, `tag_create`, `tag_delete`, `tag_rename` over one cached index of the user's tags and their feeds.
- 51da853: ARGUS shows and changes a feed's tags (#831, slice 4b). The kernel's roster model (`feed.list`) carries each feed's tags from the cached tags index (one read per tag, never per feed). The runs roster marks a feed with its tags after its title, in one theme hue; a press on a mark filters the roster by it (`tag:`, a new filter-only term in the listing façade), and its × on the indicated row takes it off. A feed row offers NOTE (the editor on `/proc/jobs/feed_N/note`) and TAG. TAG asks a new `choose` question: your tags as pills (the worn ones dimmed), a field for a new name, DONE to end; each pick runs `setfattr`, a new name `mkdir /proc/tags/<name>` first, all as visible lines, and the question comes back with the tag held. A graph on stage reads its feed's note and tags when entered and shows ADD NOTE or EDIT NOTE, TAG and the marks under BACK, re-read after an editor save. A note is never read for the roster (CUBE's feed list says nothing about notes: ChRIS_ultron_backEnd#737).

### Patch Changes

- e057d20: ARGUS edits a file in a pane (#831, slice 3). The kernel's `edit <file>` (and `feed note edit N`) opens an EDIT pane beside the focused one: CodeMirror 6 as a guest field, loaded on demand and painted from the theme's tokens; SAVE and REVERT on the mode frame, lit only while the field differs from the file; the bar says DIRTY or SAVED; Ctrl-S saves and Esc gives the keyboard back. Every save is the line the operator could have typed, `touch --withContents='<text>' '<path>'`, echoed and run, so the transcript holds each save and a feed's note is written through its projection. A second `edit` of the same file finds its pane and keeps unsaved changes; a desktop card brings the pane back on its file. brasa fixes found on the way: the semicolon splitter honours a backslash escape (an escaped quote no longer ends the quoting, so a later `;` inside it no longer splits the line), and an empty value is a value (`--withContents ''` writes an empty file instead of touching the empty word as a path).
- 2826f2b: A text file offers EDIT (#831, slice 3b). A file row whose extension is not on the binary list offers EDIT in ARGUS, a feed's note seen through `/proc` included; it runs `edit '<path>'` as a visible line and the kernel opens the editor pane, asking first for a file of a megabyte or more. The binary list moved into the contract package (`EDIT_BINARY_EXTENSIONS`, `path_isEditable`, `EDIT_CONFIRM_BYTES` in @fnndsc/menu), read by the kernel's `edit` for its refusal and by the surface for its offer, so the two cannot disagree. `feed note edit` help now says it edits in the surface's editor. New `docs/cube-feed-coverage.adoc`: each part of a CUBE feed, the kernel verb or path that reaches it, and the known gaps (rename, group permissions, revoking a grant, making a feed private again).
- Updated dependencies [2826f2b]
- Updated dependencies [c1cf57e]
- Updated dependencies [1c8b92d]
- Updated dependencies [e20fb09]
- Updated dependencies [ddbd551]
- Updated dependencies [32e3919]
- Updated dependencies [59399fe]
- Updated dependencies [51da853]
  - @fnndsc/menu@0.15.0
  - @fnndsc/cumin@3.27.0
  - @fnndsc/salsa@3.21.0
  - @fnndsc/chili@3.7.0

## 0.30.0

### Minor Changes

- 4864a34: `netstat`: the wire is a readout. The kernel keeps a ledger of every request it makes to CUBE (Node's diagnostics channels, nothing patched) — count since the session or the last reset, by endpoint family with time spent, the last few timed — and `netstat [-n <count>] [-r]` reads it as text and as the `net.stats` model.

### Patch Changes

- 51f1ca9: `cd` into a virtual directory lists it through the listing façade — the cache the boot warmed and `ls` fills serves at once, a stale entry is refreshed behind the prompt — instead of fetching the whole of `/bin` from CUBE on every `cd`.
- c9c018b: `cd` reads the parent from the listing cache before asking CUBE: every `cd` listed the parent from CUBE (three requests) to learn whether the entry was a link, though the parent was the listing on screen.
- c371b47: A feed the roster gains after the topology sweep lands its jobs on its own: every roster sync (the watcher's delta, the full walk, a restored roster brought into service) queues the feeds it leaves without topology, and one detached walk at a time lands them behind the prompt — so a feed created after the sweep, or restored from a roster whose shard was never written, shows SIZE and TIME in the RUNS listing without anyone opening it. `proc stat` names the feeds still landing.
- Updated dependencies [fbb1579]
- Updated dependencies [576b948]
- Updated dependencies [4864a34]
- Updated dependencies [7fb4c21]
- Updated dependencies [c371b47]
  - @fnndsc/cumin@3.26.0
  - @fnndsc/menu@0.14.0
  - @fnndsc/salsa@3.20.1

## 0.29.1

### Patch Changes

- cbd71cc: A refused file read says why: the kernel names the status and reason (403 not yours to read, 404 no such file, 502 CUBE could not serve it), `/vfs` answers with them instead of 404 for everything, and an image pane that lost a slice reads the reason out. `porter --end <who>` ends one session so the next login boots on the current kernel.

## 0.29.0

### Minor Changes

- fbd3f0a: The session lays the universe out itself: once the index is whole the daemon runs orrery's engines for every layout in a worker thread and keeps the places (`proc layout <name>` reports `laying` progress meanwhile). orrery is published; `layoutInput_build` builds the engines' input one way for browser and session, and the universe graph builders live in `@fnndsc/menu`. ARGUS waits on the session's progress instead of settling the same space, keeps places only for the view on stage (SHAPES apart), redraws a view already seen where it stood, and gives the session only default-physics places.

### Patch Changes

- Updated dependencies [fbd3f0a]
- Updated dependencies [fbd3f0a]
  - @fnndsc/orrery@0.2.0
  - @fnndsc/menu@0.13.0
  - @fnndsc/cumin@3.25.0
  - @fnndsc/salsa@3.20.0

## 0.28.0

### Minor Changes

- 0f9ae74: The universe laid out once per identity: `proc layout <name>` answers where a surface last laid the universe out under a layout, and `proc layout put <name> <places>` keeps it beside the index checkpoint. ARGUS puts each settled layout and, in a browser that keeps none, draws from the session's copy at once, settling only feeds new since.

### Patch Changes

- d1da8ac: `proc universe` carries what each feed's data is (`data`: format, and for DICOM modality and series description) once the index has read it. The reader follows a copy job's links (to files and to folders), reads newest feeds first, four at a time, gives a feed that never answers 45 s before moving on, records a DICOM-named file whose header will not read as DICOM with the reason, and stamps each record with its reader's version so a better reader reads feeds again.
- d8e160c: `proc universe` says when each feed was made (`createdAt`, ISO 8601), the order a replay reveals the space in; a model from an older daemon reads it as empty.
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

## 0.27.0

### Minor Changes

- 53d43f6: `mkdir` follows POSIX: `-p`/`--parents` makes missing parents and accepts an existing folder; without it a missing parent is "No such file or directory" and an existing folder "File exists". `rm` says "Is a directory" for a directory without `-r`, reads `--recursive`/`--force`/`--interactive` whole, and stays silent on `-f` of a missing operand. `mkdir`, `rm`, `cp`, `mv` and `touch` refuse an option they do not have, by name, instead of skipping it or taking it for a path. argus ensures `~/gather` with `mkdir -p`.

## 0.26.0

### Minor Changes

- 7b89dcc: brasa: `pacs query --series` answers one row per series (each carrying its study's columns) on the screen and in the CSV, and alone shows the series table. `--table` shows the answer's rows aligned: the CSV's columns, for a screen, nothing cut. `--csv --table` is refused by name (two formats for one screen); `--csv-to <path> --table` writes the CSV and shows the table. A flag the command does not know is refused by name instead of being dropped in silence. `--anon` is in the help.

## 0.25.0

### Minor Changes

- dac2d96: brasa: `motd [surface]`, the greeting a session gives on arrival — who you are, how many feeds you hold, how many jobs have run and what share failed, what is running now, from the session's own index at no cost; "so far" while the index warms; ends with a fortune. A surface may name itself (`motd ARGUS`).

### Patch Changes

- c82f514: brasa: `proc universe` names each feed.
- Updated dependencies [247bf09]
- Updated dependencies [dac2d96]
- Updated dependencies [50f8a4e]
- Updated dependencies [50f8a4e]
- Updated dependencies [c82f514]
- Updated dependencies [c82f514]
  - @fnndsc/cumin@3.23.1
  - @fnndsc/menu@0.11.0

## 0.24.0

### Minor Changes

- e74ce1d: brasa: the pronouns a chain needs, and claims that look where a plugin files its output.

  Built while writing the first battery of manifests, and each one is a thing a real workflow could not say before:

  `${run.place}` — where the last run writes. A chain works on what the previous act produced, and only the kernel knows where CUBE put it; a manifest cannot spell a path that holds an instance id it never saw. With it, `cd ${run.place}` chains one plugin onto another's output.

  `expect path <p> count --deep` and a tag claim that looks beneath the path it was given. A plugin files its output in a tree — pfdicom writes under `share/incoming/<input tree>` — so a claim made at the node's own folder was false about a run that had worked perfectly. `--deep` is declared a boolean flag, because undeclared it took the comparison as its value and the claim lost its predicate.

  A dry run leaves a pronoun it cannot know as it was written, rather than refusing: nothing has run to give `${run}` a value, and refusing there made `--dry-run` useless for exactly the manifests that chain. `play` also reads a manifest from the engine's own disk when the ChRIS filesystem has no such file, which is how a repository's battery runs without uploading itself first — and it drains the CFS miss it went looking for, which was otherwise left behind and made a clean play exit non-zero.

  A claim now prints as it was MADE, narrowing included: a ✓ reading `count gt 0` for a claim about `*.nii*` says the wrong thing held, and a battery is read by people who were not there.

- 1b2f7f7: brasa: `expect` — a claim the session can refuse.

  A workflow that only acts is a demonstration. `expect` is what makes one a test: it states a claim about the session and refuses, non-zero, when the claim does not hold. Because it is a verb rather than a harness, a workflow asserts wherever it is played — in CI, at a console, or in someone else's browser after they were handed the file.

  `expect gather size eq 14`, `expect feed 4599 status eq finishedSuccessfully`, `expect run 601152 status eq finishedSuccessfully --within 20m`, `expect path <p> count --matching '*.nii*' gt 0`, `expect path <p> tags PatientID eq anon-001`. Comparisons are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `notContains` and `matches`.

  Time lives in this verb and nowhere else: `--within` keeps asking until the claim holds or the deadline passes, which is why no other verb needs a timeout and why the language has no sleep — a sleep asserts nothing and lies about how long the work took. A failed claim prints what it wanted, what it got, and how long it waited.

  Two decisions worth naming. A subject that cannot answer — a feed this session has never indexed, a path holding no readable DICOM — is reported as NOT KNOWING rather than as a false claim, because those are different facts. And a DICOM tag that varies across a folder answers with every value it takes, so a claim about "the" value cannot pass by reading only the first file; that is what makes the tag check an honest proof that an anonymization ran.

  Third slice of the manifest work (`docs/manifest.adoc`).

- 3320487: brasa: the cohort is a kernel subject.

  `gather list|add|remove|clear|name` holds the set a session is working on, so building a cohort no longer requires a surface to press on. Membership is keyed by PATH: a PACS series still at the modality, a directory of uploads and a single file are all addressable, so one identity rule covers every kind, gathering the same thing twice merges rather than doubles, and `gather remove` takes the same operand whatever it is removing — or the index the operator just read back.

  The cohort lives where the surface already kept it, `~/gather/current.json`, in the shape the surface already wrote, so the two read each other's cohorts with no migration: the kernel fills in what an older record left out (a member written before kinds existed is a series; one written before paths were identity carries its address in `seriesUID`), and preserves the fields it has no name for, because a surface knows things about a series that the kernel does not and a kernel write must not quietly forget them. What a gathered path IS is asked of the filesystem rather than guessed from its spelling, and the holding directory is made and its listing invalidated on every write — a cohort the next `ls` cannot see is the staleness a CSV export already taught once.

  This is the first slice of the manifest work (`docs/manifest.adoc`): a workflow can now gather.

- a010cb0: brasa: `play` — a manifest runs, and plays.

  A manifest is a text file of the lines an operator could have typed. `play` reads it and feeds those lines to the session one at a time, through the same path a typed line takes — there is no second runtime, no driver and no selector language. Because every verb lowers to a line and every line's answer is a typed model the surface renders, a manifest played at a surface PLAYS: the PACS pane fills, the cohort's face counts up, a viewer opens. Played headlessly the same file prints the same envelopes and exits 0 or non-zero. Neither run knows which it is.

  A file says what it is (`@name`, `@description`) and what it needs (`@param NAME`, `@param NAME = default`). Everything it needs is settled BEFORE the first line runs: a manifest that gets half way and then asks has already changed the session. Lines may refer to what the session just did through a closed set of pronouns — `${gather}`, `${gather.first}`, `${gather.3}`, `${gather.size}`, `${feed}`, `${run}`, `${query}`, `${cwd}` — and a pronoun the session cannot answer refuses by name rather than expanding to nothing.

  A member of a cohort has two addresses and the difference matters: where it was gathered FROM, which `pull` takes, and where it LANDED, which `image` and a run take. `${gather.first}` is the first; `${gather.first.place}` is the second, and says so when a member is not in CUBE yet.

  `--pace` waits between lines, for watching a play at a surface. `--dry-run` expands everything and shows the lines without running them. `--step` is refused by name, because a keypress needs a terminal and a daemon has none. A refused line stops the play, naming the file and line, and the play exits non-zero — the second half of a workflow whose first half failed is noise.

  Fourth slice of the manifest work (`docs/manifest.adoc`).

- 8a8dc25: A patient answers to a number: `@PAT001`.

  A PACS answer asked of two patients showed `1` beside each — the patient level had no kind, so it counted itself dim per group. Patients are now a kind of their own: `PAT001`, `PAT002` in their own sequence, lit on the pane, and `pull @PAT001` or `gather add @PAT001` hands a verb every series of every study of theirs, as the row's own GATHER does. A patient has no path of its own, so its address is minted from what names it (`patientAddress_of`, in the wire package, the same string on both sides); a patient the PACS answered nothing for has nothing to hand and wears no number.

- 03e0f87: brasa: a row can be named by its number.

  An operator reads a listing and wants the third row. Saying which row meant repeating its address — for a PACS series, a line of text nobody types by hand — so acting on what you can see was a surface gesture, and a scripted session could not do it at all.

  Now a command that answers with rows records them as the session's last answer, and `@3` names one: `gather add @2,3,6`, `image @1`, `gather remove @15,16`. Lists and ranges read as they look (`@2-4`), and because the index is resolved by the one expander, every verb takes one without knowing anything about it.

  What gets numbered is the MODEL, not a rendering of it, so a console table and a graphical pane count the same rows — an index that meant different things on different surfaces would be worse than no index. What a row is worth is declared per listing (`fs.listing` and a PACS answer give paths; the cohort gives its members' paths), so a verb receives the operand it already takes.

  The sigil is what keeps it honest: a directory called `2` is a path and `@2` never is, `'@2'` in quotes is text, and `user@host` is not an index because only a number at the start of a word is one. A line that acts on a number says which listing it counted (`from: ls ~/uploads · 7 rows`), and a number past the end refuses with how many rows there are rather than acting on the wrong one. An answer with no rows does not replace one that has them: an empty `ls` should not un-number the listing just read.

  Numbering lives as long as the session, so at a daemon it spans commands and at `chell -c` it spans the one line — `ls ~/uploads; gather add @1` is the one-shot form.

- 1bdf876: A row wears the number it answers to.

  A row of the session's last answer can be named by the number beside it — `gather add @2,3,6`, `image @1` — so the number is now DRAWN beside it. The listing façade mints a leading index pill for any level that says how its rows are addressed, and no pane draws a number itself.

  What is numbered is the kernel's ANSWER rather than a rendering of it, so a console table and a graphical pane count the same rows. The lit number is found BY ADDRESS, not by counting down the screen, so a sorted or filtered listing keeps each row's own number instead of renumbering under the operator.

  Every listing leads with the column and every row counts itself; only the rows the kernel reaches wear a LIT number. In a PACS answer that is the series, while the patient and study levels above count themselves dim — the distinction is the hue, never the digits, so a number nothing answers to cannot be mistaken for one that does. Numbers are zero-padded to the widest in their group, so a fourteen-series answer reads 01…14 and the column stays a column. The lit hue is the pane's FRAME hue (`--listing-index-hue`, set per pane), because the pill is chrome and not content: an orange pill beside the browser's orange kind glyph read as one blob and the number stopped being a number.

  The surface learns which listing is numbered from a retained `numbered` message: brasa announces it as the answer changes, calypso relays it and replays it to a surface attaching late, and the addresses travel with it (capped, past which a long listing is numbered in the kernel and unnumbered on screen). The same shape regard already travels in.

  Law: `a-row-wears-the-number-it-answers-to`.

- 854ba2e: brasa: a verb that starts work waits for it.

  A run returned the moment CUBE accepted it, which reads as completion and is not: the next line of a script worked on output that did not exist yet, and the only way to sequence work was a sleep — a lie about time. Running a plugin from `/bin`, `plugin run` and `pipeline run` now wait until every node they scheduled reaches a status it does not leave, and report what happened: how long it took, and which node failed when one did (a failed run exits non-zero, so a script can be believed).

  `--detach` asks for the handle instead, which is what these verbs did before; `pull` gained `--detach` as the language's word for the `--nowait` it already had, and still answers to both. A cancellation — Esc at a surface, Ctrl-C at a console — DETACHES rather than kills: the run continues and its handle is printed, which is `--detach` asked for later. Progress goes out on the progress channel throughout, so a surface shows the work moving rather than a frozen line, and losing touch with CUBE is reported as not knowing rather than as failure, because a run whose status cannot be read has not failed.

  A pipeline schedules several nodes at once, so a wait is over the SET: it ends when all of them have settled, not when the first does.

  Second slice of the manifest work (`docs/manifest.adoc`).

- 80ddce6: brasa: `record` — a session writes itself down as a manifest.

  The workflows worth sharing are the fiddly ones nobody will retype correctly. `record start <manifest>` … `record stop` captures the lines the session runs and writes them as a manifest someone else can play. It costs almost nothing because the lowering was already the law: a press on a surface and a line at a console arrive at the same place, so both are captured alike.

  A recording is a TRANSCRIPT and stays one. It never invents expectations — a file that guessed at assertions would be a fiction, and adding `expect` lines is the author's act, the one that turns a recording into a test. It does not film its own camera (`record` and `play` lines are not captured), and it does not capture the lines a played manifest runs, which are already written down in the file being played.

  What makes a recording personal is its identifiers, so the ones a PACS line wears on its face — `PatientID`, `AccessionNumber`, `PatientName` — are offered as parameters, written as defaults so the file still plays exactly as recorded. The same value gets one name wherever it appears and a second distinct value gets a name of its own, so a workflow over two patients does not collapse into one. A value stops at an underscore or a slash: a query's projection folder is `PatientID:1279049_qid:3125_owner`, and a looser match would have parameterized the query id along with the MRN.

  Fifth slice of the manifest work (`docs/manifest.adoc`).

- 5b520c7: An index says what it counts.

  `@2` said nothing about what it counted — in a PACS answer every study read "1", being the only study under its patient — so a bare number is no longer an index. A handle names its KIND and its place in that kind's sequence: `@SER3`, `@STD001`, `@FIL2,3,7`, `@DIR2-4`. One sequence per kind runs across the whole answer, so a handle is a name rather than a position and a sorted listing does not renumber it; zero padding is how the pill draws it, not something to type.

  What a row hands over differs by kind. A series, a file or a folder hands over its path; a STUDY hands over its series — what the surface's GATHER on a study hands over — so `gather add @STD001` and `pull @STD001` act on the whole study from a console exactly as a press does. A verb refuses a kind it does not take, by name and at expansion: `image @STD001` says "image takes a series or a folder or a file; STD001 is a study" instead of resolving to a path and failing three steps later for a reason that names nothing typed.

  On the surface the pill draws the handle, lit in the pane's frame hue on the rows the session reaches, and a study row wears `STD001` where it read a meaningless "1". The `numbered` message carries each row's kind, place and address, so a pane finds its rows by address and draws the code the operator would type.

- ca3e39b: brasa: one expander, owned by the tokenizer.

  There were two, over one syntax. The dispatcher substituted the environment AFTER tokenizing, so a single-quoted `$HOME` expanded anyway and quoting could protect nothing. `play` substituted parameters and session pronouns BEFORE tokenizing, so a gathered path with a space had to be quoted by hand and an unresolved pronoun could fall through to the other expander. Two sources of truth that composed by accident.

  Now the tokenizer records references with the quoting they were written in, and one resolver answers them: the session's reserved pronouns (`gather`, `gather.first.place`, `feed`, `run`, `run.place`, `query`, `cwd`), then the played manifest's parameters, then the environment. `play` no longer substitutes anything; a manifest that declares a `@param` with a reserved name is refused when the file is read.

  The shell's rules, kept, because the stack claims to wear them: a bare reference carrying several values becomes several operands, a double-quoted one stays a single operand, a single-quoted `$` is text, and an expanded value never globs afterwards. The command word expands too — a manifest names its plugin as a parameter so the same workflow runs where the builds differ.

  A reference nothing answers now REFUSES the line, naming it and where it looked, rather than expanding to nothing or standing as text: `rm -rf ${DIR}/scratch` with `DIR` unset is how a script deletes the wrong thing. A dry run is the one exception, having run nothing yet.

  Behaviour changes worth knowing: `'$HOME'` in single quotes no longer expands (it did, wrongly), and an unset reference refuses where it used to be left as literal text.

- 7bba167: The door hands a token: a session can be started by a front that already logged the operator in.

  Today a session is started by the operator, at a terminal, with a password: `chell user@url -p … --daemon`. A login front on a shared host — the porter, the display manager the browser surface needs — exchanges the password for a CUBE token itself and holds the token, never the password. This is the seam that lets it start a session with what it holds.

  - cumin `connection_connectWithToken({ user, url, token })`: proves the token against the server BEFORE writing anything, so a refusal leaves the saved context alone; never exits the process; the refusal travels in the outcome, not on the error stack.
  - brasa `sessionConnect_withToken(user, url, token)`: the headless connect beside `sessionConnect_fromSaved`, setting the context the way a credentialed boot does and leaving the working directory as it was.
  - chell `--auth-token-stdin`: the token comes in on stdin, one line, never on argv where `ps` shows it to the host. Refuses by name: without a `<user>@<url>`, beside `--password`, or with no line on the stream. The boot row reads `Connect  Connected to <url> (token)`.
  - chell `--daemon` off a TTY no longer spawns a console onto its pipe — a boot ends at a login only where there is a terminal to log in on; otherwise the daemon says so and keeps listening, as the standalone `calypso` binary already did.
  - menu `@fnndsc/menu/logo`: the mise brain and its frame renderer move from the kernel to the wire package, decoding with `atob` and touching no Node builtin, so a browser can draw the same brain a terminal boot does. brasa re-exports it; chell and calypso keep their import.

  Exemplar `14_tokenLogin` starts a daemon this way against a live CUBE, off a TTY, in isolated directories, and proves the Connect row and a live berth.

- fc4eb7e: brasa: `weather [place] [-u|--units metric|imperial] [-d|--days N]` — the conditions now and a short forecast for a place, from Open-Meteo (no key, no account), geocoded by name; Boston when no place is given, metric unless `--units imperial`. A kernel command, so a TTY and ARGUS show the same report; the typed `sys.weather` model carries the numbers beneath it. Unknown flags refused by name; an unreachable service or an unknown place answers in one line.
- 43b9440: The space of everything run here: the wait is drawn with what is known, and UNIVERSE is a face.

  While the job index warms, RUNS-02 had nothing to show but a refusal and a moving figure. Now the session reports each feed as the index reads it — its jobs collapsed by plugin per place in its pipeline (a fan of three hundred conversions is one node of 300), with a status on every node — on the prompt context (`procWarmup.landed`), and the pane draws them as they arrive: every feed its own small DAG, floating free like molecules in a solution, counts as weight and status as hue, feeds of one pipeline shape pulled together by an unseen anchor so the space settles into constellations. Every node is real. When the index is whole the roster takes over, as before.

  `proc universe` answers the same picture from the cache at any time, whole or warming, and says which; the dashboard's UNIVERSE tile opens it on the RUNS canvas. A feed's status words are now the DAG's own (`finishedWithError`, `started`, …) wherever cumin derives them from counts, so a feed on a surface wears the hue its jobs would.

### Patch Changes

- 3c6a0d3: ARGUS and kernel: the gather gesture is reachable, and an exported table is visible where it landed.

  Three faults found by running the operator's own flow against a live PACS.

  **GATHER SHOWN was invisible.** It was put on the results mode frame, which is the closed spine at rest: measured live, 22px wide and `visibility: hidden`. It now stands beside EXPORT CSV on the command row, where the verbs that act on the whole answer already live.

  **GATHER was offered only once a series was home**, so on a fresh answer, where nothing is home, the gesture did not exist. A cohort is a set of targets and the feed it roots is made by a pull over its members, so a series is gatherable once it can be named: a PACS path, or the fact that it has landed. Query, filter, take what matched, fetch it as a set. PULL still means bring this one now.

  **The export was not broken; the listing was stale.** The CSV writer wrote straight to CUBE and never invalidated the folder's cached listing, which every other fs verb does — so `cat` returned the file while `ls` and every browser showed the folder without it. The write now invalidates the folder it wrote into, and the one that shows a folder it had to create. The WROTE readout also opens that folder when pressed.

- Updated dependencies [e74ce1d]
- Updated dependencies [8a8dc25]
- Updated dependencies [1bdf876]
- Updated dependencies [3320487]
- Updated dependencies [a010cb0]
- Updated dependencies [5b520c7]
- Updated dependencies [7bba167]
- Updated dependencies [1c169d7]
- Updated dependencies [43b9440]
  - @fnndsc/salsa@3.18.2
  - @fnndsc/menu@0.10.0
  - @fnndsc/chili@3.6.7
  - @fnndsc/cumin@3.23.0

## 0.23.2

### Patch Changes

- 48e112d: Kernel: a DICOM address is followed to the bytes behind it.

  A `pl-dircopy` of a PACS pull does not copy the files: its output folder is a link, and the DICOM under it is stored beneath `/SERVICES/PACS`. `dcm series` and `dcm tags` resolved the path they were given against the cwd and stopped there, so the logical name matched no file id and every slice of a pulled series was unreadable from the feed it was pulled into. The listing showed the files; nothing could open one. The same series read fine at its PACS address, and `cd` into the folder — which does follow links — made the very same command work on the very same file.

  Both commands now resolve the address the rest of the file verbs already do: a projection through the provider that owns it, then the link walk. `file_read`, the door behind the browser's byte route, follows a node's data link the same way when the folder it lands on is itself a link. Resolution is best effort, so a path that resolves no further stands as it was and the command still refuses by its own name.

## 0.23.1

### Patch Changes

- 3f96d86: A daemon comes up where the operator left it. A credentialed boot used to write `/` into the working-directory context after connecting, so every restart began at the root whatever was stored; it no longer touches the directory, and with nothing stored the kernel's home default (`/home/<user>`, now exported as `homePath_of`) applies to the boot context too.
- 6d8a595: `pipeline run` answers with the `run.scheduled` model a plugin run answers with (pipeline name, first instance, feed), so a surface lights the feed it landed in without reading the id out of the text.
- a4a38b1: A file under a `/proc` projection can be read. The proc provider resolved a node's `data` to the CFS file behind it and then handed that file back to the dispatcher, whose default provider is the host filesystem — which refused it; it now reads the target through `fileContent_get`, the door that knows both worlds. The engine's `file_read` (the daemon's `/vfs` route) resolves the path it is given, so a surface can read a file at the address the session uses for it.
- 0d99ec5: `pull --new-feed` answers with a `feed.created` model beside its text: the feed it made, its pl-dircopy root instance, the owner, and the root's data folder, so a surface binds to the place rather than parsing the id and path out of the lines.
- 480632d: A scheduled run answers with a typed model. Running a plugin from the shell now returns a `run.scheduled` envelope model (the executable, the instance, the feed it landed in, whether that feed is new, the output path) beside the lines it already printed, so a surface can point at what it started rather than parse the console.
- b4d9282: A first session begins in the identity's home directory. Before the context had stored a working directory the session answered `/`, which is a place nobody works in; it now answers `/home/<user>`, as a shell would. A stored directory is always honoured, the root included.
- b337285: `image` is a kernel command, but it was missing from the two places that enumerate commands for the operator: tab-completion (offered from the help registry) and the grouped `help` listing (grouped by a hardcoded category map that had no imaging category). It had a help entry, so `image --help` worked, but the entry carried no summary and belonged to no category, so it never appeared in `help`. Now `dcm` and `image` share an `Imaging` category in the listing, the `image` entry carries a one-line summary, and `image`/`dcm` take path-argument completion like the other path commands — so `ima⇥` completes to `image` and `image ~/up⇥` completes a path.
- ab127ea: `plugininstance list` answers with a `plugininstance.list` model beside its table: the listed instances as typed rows (id, plugin name and version, feed, owner, status, start), the fields the listing selected. A surface reads its run history rather than scraping it.
- Updated dependencies [a4a38b1]
  - @fnndsc/salsa@3.18.1

## 0.23.0

### Minor Changes

- 9cf2ea2: `image <path>`'s text reflection now carries a thumbnail of the middle slice, so a TTY sharing the session shows the picture, not only the facts. The kernel reads the slice's pixels (`dicomSlice_gray` in salsa, uncompressed transfer syntaxes via dcmjs), window/levels to 8-bit with MONOCHROME1 inverted, and box-downsamples to a cell grid; brasa renders it as an ASCII ramp on any pipe or ANSI truecolour half-blocks (`▀`) on a colour terminal. Colour is a new declared surface capability: ARGUS declares it (its DOM console renders ANSI), chell reads its own terminal through chalk, a bare pipe gets the ramp. Compressed pixels say so in one line rather than pulling a codec into the kernel; an unreadable slice leaves the facts and no picture. The ASCII ramp is always the floor.
- d133ef6: `image <path>` is a kernel command, not a surface verb. A new brasa builtin resolves what a path is — a DICOM series folder, a study, a `.dcm`, or a NIfTI/MGZ volume — and emits a typed `image.view` intent (schema and `IMAGE_MODEL_KINDS` in `@fnndsc/menu`) that every surface renders in its own way: ARGUS opens a rendered pane from the intent, a TTY prints the reflection the command renders (for a series, the same facts `dcm series` shows). So the same `image ~/uploads/sag-anon` works from a browser and from a terminal sharing one CALYPSO session. The surface keeps only the subverbs that drive a pane already on the field (`image layout|slice|wl|colormap|save|tags|load|guard|ghost`), declared shared so `image <path>`, `image --help`, and `image` alone fall through to the session; help lives in the kernel's registry. Opening an image no longer drifts into a surface-only verb.
- c70e11e: A landed series says where it was filed, and the image pane answers the press at once. A retrieve is confirmed by count and filed by CUBE a beat later, so the pull's "done" never knew the folder and a surface offering IMAGE on the row waited for the next query. The progress message now carries an optional `path`, `pull` resolves each landed series' folder before its channel closes and says it on the same channel, and the ARGUS PACS row takes the folder from the landing: IMAGE appears the moment the pull says the series is home. In the same breath, `image <path>` puts the pane on stage before the kernel is asked, with `OPENING <name>` on the field and on the bar, so a header read that takes seconds is never seconds of nothing; what could not open is named on the field, and counted loads say their percentage beside the count.

### Patch Changes

- Updated dependencies [9cf2ea2]
- Updated dependencies [d133ef6]
- Updated dependencies [c70e11e]
  - @fnndsc/salsa@3.18.0
  - @fnndsc/menu@0.9.0
  - @fnndsc/cumin@3.22.1

## 0.22.0

### Minor Changes

- 163e4b1: `pacs query --anon` stands in for what an answer says about a person, for demonstrating against a live hospital PACS. Record numbers and accessions become salted tokens, a name becomes a stand-in name of the same DICOM shape, a study date falls back to the first of its month and a birth date to its year. The substitution happens on the decoded payload, so the model a surface renders, the console table and any CSV all say the same thing. The salt is made once per daemon and never written down, which makes tokens stable through one demo and meaningless after it: an unsalted digest of a seven-digit record number is a second's work to reverse. DICOM identifiers are left alone, since they are never shown and are what the held-state reconciliation matches on.

### Patch Changes

- aa923c6: A replayed PACS query no longer costs a round trip per series. Reconciling a stored answer against what CUBE already holds asked about every series in turn, two requests each, and held the whole answer back until the last one replied: a patient's history of 299 series took 20.6 seconds against a live CUBE, so a replay — whose entire purpose is not to trouble the wire — felt exactly like a fresh query. CUBE indexes a stored series by its study, so the reconciliation is now one page per study, with file counts fetched only for the series actually home. The same question costs 3.1 seconds. `seriesStorage_resolveMany` is the new bulk resolver; the per-series resolver stays for the paths that need it and for a study the answer cannot name.
- 59aa79b: A run now follows itself until it settles, so the header's pulse tells the truth without a pane open on the feed. A new feed entered the cache with its jobs scheduled and nothing revisited them, so RUNNING stayed at zero through the operator's own run and SCHEDULED only ever climbed — one header read `SCHEDULED 90` with nothing running. Starting a run takes out a watch on that feed; the sampler already knew to stop when the feed settles. The watch is taken where a run is started, never inside the cache-writing helper, which would make recording a feed quietly begin visiting CUBE.
- Updated dependencies [163e4b1]
- Updated dependencies [aa923c6]
  - @fnndsc/salsa@3.17.0
  - @fnndsc/cumin@3.22.0

## 0.21.0

### Minor Changes

- af2df66: New `dcm` builtin: `dcm series <folder>` renders a folder as a series and carries the `dicom.series` model; `dcm tags <file|folder> [--all] [--filter <text>]` renders a grouped tag listing, or a folder's constant and varying tags, and carries `dicom.tags`. Folder listings read every file up to 512 then sample evenly, and the text says how many were read of how many, and which were refused.

### Patch Changes

- 7c793ad: `pacs query` fills each pulled series' `folderPath` from the storage state it already resolves.
- 0eb202f: `dcm tags --filter` descends into sequence items, so a needle inside a referenced-image sequence keeps the sequence on screen.
- 183bf02: `rm` treats an abandoned question as an answer, not a failure. A confirmation that comes back with no answer — the operator pressed Esc, or the surface lost its ability to ask — used to abort the per-file `-i` walk with `rm: cannot remove '<path>'`, an error over a file nothing had touched, and left every file behind it silently unoffered. It now skips that file by name, says why, stops asking, and says how many it left alone. The one-question `-I` path keeps everything as before and now states the reason too, so a surface that has quietly lost its voice is not reported as an operator who declined.
- Updated dependencies [7c793ad]
- Updated dependencies [af2df66]
- Updated dependencies [af2df66]
- Updated dependencies [b9ec3aa]
  - @fnndsc/menu@0.8.0
  - @fnndsc/salsa@3.16.0
  - @fnndsc/cumin@3.21.1

## 0.20.0

### Minor Changes

- 3d11f59: Boot readout, second pass. A step that starts as `[PENDING]` (or falls to `[RETRY]`) is now rewritten in place when its outcome lands, the way a boot screen settles a row rather than repeating it beneath, so a settled step leaves one `[ OK ]`/`[FAIL]` row and no open pending row. The brain animation and the readout now share one stdout row counter, so neither miscounts the other's scrolling; a row that has scrolled off the screen, or an outcome taller than the pending row it replaces, appends as before. The daemon banner paints each package in three parts (its name bright, the rest of its backronym plain, the version dim in one column) and carries the build hash on its own CALYPSO row, so the redundant headline line is gone; a remote surface paints the daemon's stack the same way.
- 9c320a0: The boot ends at a login. An interactive `chell --daemon` no longer rests on the console face: once the daemon is listening it puts an ordinary `chell --remote --attach` surface on its own terminal, as a child on the wire, so the boot log runs straight into a prompt. `exit` detaches and leaves the daemon running, Enter attaches again, Ctrl-C at the idle terminal stops the daemon, and whatever the daemon writes while a surface holds the terminal is held (calypso `consoleCage_start`/`consoleCage_stop`) and printed on detach. Every chell REPL, local or remote, now guards its idle prompt: a stray line (another surface's output, a late warm-up) lands on its own line with the prompt redrawn beneath it.

  The boot readout is lifted with it. A warm-up step running behind the prompt printed its pending row twice and never reported an outcome; it now prints once as `[PENDING]` and settles on the daemon's readout as `[ OK ]` with what it cached or `[FAIL]` with why. Every count takes its noun in the right number (`1 PACS query`, `3 feeds`) through a new brasa `count_noun`. The daemon banner writes every package out in full (brasa `stackBanner_build`/`stackBanner_compose`), adds an ARGUS row when a web surface is served, and drops the welcome; the remote surface banners the daemon's stack the same way. A daemon bound on every interface advertises its fully qualified host name.

### Patch Changes

- d89e31b: A feed-list row now carries `jobsErrored` (the errored-or-cancelled count, from the proc cache's per-status counters), so a surface can fill an errored feed's progress bar to the work that actually succeeded — `jobsDone - jobsErrored` over `jobsTotal` — rather than run it full in the error hue. The RUNS roster uses it; a full red bar said nothing a red mark would not.
- Updated dependencies [711e1b3]
- Updated dependencies [612c052]
- Updated dependencies [d89e31b]
  - @fnndsc/cumin@3.21.0
  - @fnndsc/salsa@3.15.0
  - @fnndsc/menu@0.7.0

## 0.19.0

### Minor Changes

- 49634f2: feat(brasa): the index snapshot the daemon heartbeats carries CUBE's pace
- 2545ffa: feat(brasa): the index snapshot carries the lab's pulse — jobs running and waiting, and the feeds that errored — derived from the roster's counters

### Patch Changes

- Updated dependencies [49634f2]
- Updated dependencies [49634f2]
- Updated dependencies [2545ffa]
  - @fnndsc/cumin@3.20.0
  - @fnndsc/menu@0.6.0

## 0.18.0

### Minor Changes

- 6cd5ab1: feat(brasa): `feed diagram`, `feed tree`, wire `feed.dag` and `proc refresh <feed>` answer at once with `feed.indexing` when the feed is cold; a feed watch holds the floor while its topology is indexing, never settles on an empty topology, and is kicked by the cache the moment the walk lands
- 57ba039: feat(brasa): the prompt context names every feed walk in flight, not only the earliest
- 98ab832: feat(brasa): `proc feeds` and `proc jobs list` answer from the cache at once and start the roster sync off the session's lane; the prompt context names the walk while it runs

### Patch Changes

- Updated dependencies [6cd5ab1]
- Updated dependencies [6cd5ab1]
- Updated dependencies [6cd5ab1]
- Updated dependencies [57ba039]
- Updated dependencies [57ba039]
- Updated dependencies [57ba039]
- Updated dependencies [adf8cc1]
- Updated dependencies [adf8cc1]
- Updated dependencies [98ab832]
- Updated dependencies [98ab832]
- Updated dependencies [98ab832]
  - @fnndsc/cumin@3.19.0
  - @fnndsc/menu@0.5.0
  - @fnndsc/salsa@3.14.0

## 0.17.0

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

- 349d7d2: feat: a missing destination is asked for, not refused with a usage line

  `mv foo` names what to move and never says where. Until now that was a usage line — telling an operator the shape of a command they had just typed correctly enough to be understood, instead of asking them the one thing they had not said. A required operand with no value is the same sentence as a value-taking flag with no value, and now gets the same answer: `mv` and `cp` ask.

  The ask is the typed `path` ask that already exists, so neither verb knows which surface it is talking to: a terminal renders it as a line, and a surface that browses borrows a files pane for it. It opens where the source already lives, wants a directory when there is more than one source, and its committing control reads `MOVE HERE` or `COPY HERE`.

  It offers no default name. The only name `mv` could propose is the source's own, and the first live run took Enter as exactly that and moved a file onto itself. The rule that came out of it holds for every path ask, and the terminal now implements it directly: the **anchor** says where to look, the **suggestion** says what to offer, and a verb with nothing to offer offers nothing — Enter on such a question answers nothing rather than answering with the question.

  An abandoned ask moves nothing and says so (`mv: no destination given; nothing moved.`), rather than failing with a description of `mv`.

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

- 116e8ba: feat(listing): progress is a trait of a row, and a row can carry verbs

  The operator's observation: progress is not a PACS quirk. A feed row should say how far its work has got without anyone opening it, and every level should report — a series its own pull, a study the sum of its series, a patient the sum of its studies.

  **The wire could not say it.** The `feed.list` model carried id, title, owner, status, created and two totals that need resident topology, so a roster genuinely could not know a feed's progress. CUBE's own job counters were already on the process cache, so the kernel now derives `jobsDone` and `jobsTotal` from them — settled meaning finished, errored or cancelled — and they travel with the feed row rather than waiting for topology. Kernel, wire, surface, in that order.

  **Progress aggregates by addition, not by average.** A study's progress is the sum of its series'. An average would let one finished series of a hundred files outweigh a stalled one of ten thousand.

  **A row with nothing scheduled still gets a track**, dimmed. The absence of a bar reads as "no such thing"; a dim track reads as "nothing has happened yet", which is the truth and the more useful statement.

  **Actions are not traits.** A trait says what a row is under some column; an action is a verb applied to it, and it sits outside the column grid because it answers to no cap. Capsules stop click propagation, so pressing one is not also activating the row.

  **Expansion has two modes**, declared rather than assumed: `replace` leaves the parent behind, `fold` keeps it on stage with the child inside. PACS exercises both in the next slice.

  The runs roster gains NODES and PROGRESS, which widened its positional track list from seven columns to nine.

  One smoke assertion changed, and deliberately: it counted seven cells per row as a literal. It now counts cells against the number of caps, which is the invariant that actually protects a positional grid and needs no edit when a column is added.

- ba1e5b4: feat: a PACS answer can be written as a table a spreadsheet reads

  `--csv` renders the answer; `--csv-to <cfs-path>` writes it into ChRIS storage; argus's EXPORT CSV lowers visibly to the second, as GATHER's SAVE already lowers, so the operator reads the command that ran.

  Two flags rather than one with an optional value: `--csv PatientID:1234` cannot tell a destination from a query expression, and guessing wrong writes a file named after a patient.

  **Why a CFS destination exists.** A local terminal needs none — `--csv > audit.csv` writes the operator's own disk, because engine and operator share a filesystem. A detached surface does not: the engine runs on the daemon's host, so a redirect lands on somebody else's machine (#415, where `>` also turns out to bypass the `engineFilesystem` capability built to prevent exactly that). A cohort's MRNs and study descriptions stay inside ChRIS, and the file browser or `download` retrieves them.

  **The table's shape carries the level above's doctrine**: a row per study, and a row for every patient that owns none. A table built from studies alone would silently drop the misses, which are what an audit is usually asking about. `ANSWERED` carries an ISO timestamp rather than `3 MONTHS AGO` — a spreadsheet sorts dates; a phrase is for a human glance.

  Every cell is quoted and embedded quotes doubled, the rule chili's `--csv` has always followed, now stated as a function rather than left inside a handler nothing else can call — so a study description like `MRI BRAIN, W/ AND W/O "GAD"` survives the trip.

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

- 7181f7e: feat: a PACS question can be put to several servers at once

  `--pacsserver a,b` asks each named server and unions the answers into one listing. It is the same fan-out a cohort uses, discriminated by a different column: SERVER rides every study and every patient row, so two answers can be told apart, sorted and filtered.

  **A row names its server only when more than one could have answered.** On a single-server query the column would repeat one value down the page and tell an operator nothing.

  **There is no sweep-everything.** The CUBE this was designed against carries thirteen registered servers, several reading as one-off or per-person registrations; an `--all` would mean thousands of C-FINDs mostly into endpoints of unknown liveness. A fan-out is always something the operator named.

  **A server that could not be reached is `unasked`, not empty.** Verified live: naming a server that does not resolve leaves that row `—` with its reason while the server that did answer still reports what it found. A server that could not be reached has told us nothing about that patient; rendering it as a zero would say the opposite.

  The reason on such a row is stripped of the error stack's debugging prefix where it becomes model data, since it is read in a terminal table and on a graphical surface alike.

  Servers are keyed by their canonical identifier — what CUBE files a query under, and therefore what the replay index matches on, so a question already asked of one server replays while the same question to another is asked fresh.

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

- 5a339f0: feat: a plugin is data — the manual becomes a projection of the model

  A plugin's substance existed only as text. `cat /bin/<entry>` fetched the plugin, formatted a manual, and that manual was the whole of what any surface could have — a paragraph nothing downstream can act on: not a card, not a parameter list, not a form, not an export.

  The kernel now builds the model first and renders the manual from it. `plugin info pl-dcm2niix-v2.0.0` answers with a `plugin.info` model carrying identity, the authoring facts, and every declared parameter; `cat /bin/pl-dcm2niix-v2.0.0` prints exactly the text it printed before, now as one projection of that model rather than a second independent scrape that can drift from it.

  **Parameters carry the flag as it is typed.** A plugin's own `flag` when it declares one, `--name` otherwise — a form built from the name alone would spell `--inputFile` where the plugin wants `-i`.

  **The parameter list is drained to exhaustion.** `getPluginParameters({ limit: 100 })` was one of the silent truncations catalogued in #401: a plugin declaring more lost the tail and said nothing about it. `pluginParameters_drain` walks to the end, and a live exemplar checks the model's count against the count CUBE itself reports — a client that both fetches and counts can agree with itself while being wrong.

  cumin gains `plugin_find` and `pluginParameters_drain` on the typed contract, so the `/bin` reader no longer reaches past it to the raw client.

  No surface change: this is the wire fact a plugin's one-node graph will read.

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

- 78d85ae: feat(argus): a location is asked for by borrowing a browser

  An ask is never a box. A `path` question opens the instrument that already shows that space: a **new** files pane beside the pane that asked — never an existing browser, since hijacking one loses the operator's place — anchored where the ask said, closing when the errand ends either way.

  Its controls ride a bar of its own across the top of the pane: the question as a caption, the composed path as an editable field, **MKDIR** for a folder that does not exist yet, and one verb that commits, reading the word the kernel sent (`EXPORT HERE`). The grill had put those on the mode frame; building it showed why they cannot live there — the frame is a narrow rail against the spine, right for a column of capsules and hopeless for a caption and a path, and it answers to what the _field_ holds, which an errand does not change.

  Three defects the live run turned up, each fixed here:

  - **The errand opened an empty browser, forever.** The daemon runs commands one at a time, so the listing that would answer the question queued behind the command that asked it: the answer waiting on the browsing, the browsing waiting on the answer. An instrument command now runs **beside** a command waiting on a question — the natural twin of the rule that an instrument may never ask. A pane's own read neither asks nor waits, and the daemon saves and restores the executing command rather than clearing it, so the outer command's output still finds its way home.
  - **The errand split beside the focused pane**, which can be one the current preset does not hold. A split beside a pane that is not in the tree fails silently, and an errand that never opens is a question asked of nobody. The host is now a leaf that is actually on stage.
  - **The anchor could be somewhere nothing can be written.** A session sitting in `/bin` or `/proc` is browsing a provider, not standing where a file lands, so the ask falls back to home rather than offering a destination that is refused the moment it is committed.

  Law `an-ask-borrows-an-instrument`, smoke-enforced. Two consecutive full smoke runs, 103 checks.

- 8312a79: feat(chell): a terminal answers the same typed question

  A terminal has one instrument — a line — so a location ask cannot borrow a browser the way a graphical surface does. It renders into the line instead: the composed default in brackets, and Enter takes the offer.

  ```
  Where should the table go? [/home/rudolphpienaar/pacs-2026-09-07.csv]
  ```

  The answer a terminal commits is then the same answer an errand would have committed, without either surface knowing the other exists — which is the point of putting the _kind_ on the wire rather than a rendering. A yes/no says which letters it takes and offers no default, because there is no safe guess. A prompt from a daemon that predates typed asks reads exactly as it always did.

  Exemplar 12 closes the epic by driving the whole path through the kernel with a scripted surface: a value-taking flag given no value asks and the question says what it wants; the answer is what happens next and the file lands where it said; abandoning writes nothing and the command says so; and a session sitting in a provider path is not offered as a destination.

  It caught the epic's last defect: **an abandoned ask was throwing the answer away with the writing.** The model crosses either way now — the operator waited for that answer, and only the writing of it did not happen.

- 3df1c41: docs(calypso): say calypso where the component is meant, and make it typeable

  Every other part of the stack is a noun with a role — cumin, salsa, chili, brasa, menu, chell, argus. The session supervisor was the odd one out, described by a flag on another program, so the prose said "the daemon" for something that already has a name, a package, a binary and a doctrine document.

  Host control is _calypso's_ policy; berths are calypso's; the wire is calypso's. "Grant calypso host access" says whose policy changed. "Grant the daemon" does not.

  Operator-facing text now names it: the flag help, the not-running message, the already-running refusal, the listening banner, the attach errors, the several-sessions chooser, and the host-control sentences — `upload` refusing without the `files` tier, the HOST banner, and argus's HOST lamp tooltip.

  The start hints used to read `chell --daemon <user>@<url>` while the prose said "run calypso". They now say `calypso <user>@<url>`, which is a real command, since calypso ships its own binary. The getting-started guide leads with what calypso _is_, then gives both ways to start it — standalone from a saved session, or through chell logging in fresh — because they genuinely differ and one does not replace the other.

  **Daemon survives where it is correct**: a mode name, an anchor, a make target, a background process. Code symbols are untouched — `daemon_launch` and its kin describe something that really is a daemon, and churning them buys nothing an operator sees. Command lines inside code blocks were left alone, so nothing became a command that does not exist.

- f5c16fe: fix: a listing says what it could not read, and cat reports instead of crashing

  **A listing that could not read part of itself says so.** `ls` asks a folder for its directories, its files and its links, and a refused sub-listing was being dropped for looking like an empty one — so the home root whose file listing CUBE refuses rendered its folders alone, as though that were everything. The provider now names what it could not read (`Cannot fully list <path>: could not read files (Internal server error)`) and the listing carries that reason with the entries it did get.

  **`files_listAll`'s `null` meant three things** — an empty folder, a folder that is not there, and a folder the server would not describe — and nothing above it could behave correctly on one word that means all three. `files_listOutcome` says which: `listing`, `empty`, `missing`, `refused`. `files_listAll` stays as the lossy wrapper, but a refusal now throws rather than passing for absence.

  **A file is deleted by its id**, not by finding it in a listing first. The folder whose listing the server refuses is exactly the one an operator needs to clear, and a delete that walks the parent cannot help there. `chrisIO.file_deleteById` is the new door; other asset kinds still resolve through the group.

  **`cat` reports an unreadable path instead of ending the session.** A read that threw — a path that cannot be resolved, a server that refuses — escaped as an unhandled rejection that dumped an axios request object, auth header included, and killed the process. Each path is now resolved and read inside its own guard: the failure is reported like any other unreadable file, the rest of the line still runs, and nothing is dumped.

- ec3ef9f: fix: a listing shows what is there — no silent page limits

  `ls /net/pacs/queries` answered with 100 of 1,817 stored queries and said nothing about the other 1,717. That was one symptom of a pattern: callers reaching a single-page list call with a literal limit and returning the page as though it were the collection.

  **The default is now the collection.** A caller that names no limit gets a walk to exhaustion, not the first twenty. A caller that names one gets exactly that page, marked `incomplete` with what it is showing of what exists — a bound the surface can state rather than a truncation nobody sees.

  **A walk that stops says where.** CUBE fails some collection queries past an offset (measured: `userfiles` answers to offset 800 and returns 500 at 1000). The walk keeps what it gathered and reports where it stopped, rather than handing back a prefix that reads as an ending. A walk whose _first_ page fails is still a failure, since a listing that never started is not a short listing.

  **Three callers fixed:**

  - `pacs status` searched the first 200 queries for a matching expression, so anything older answered "not found". It walks now — verified live against a log of 1,897, finding query 3.
  - `getfacl` read a feed's first 100 grants. A hundredth name is not a natural place for that answer to stop.
  - A `ts` node's join edges are read from its parameters, which were fetched one page deep. A node with more parameters than a page silently lost its edges — a graph drawn short.

  **And a gate**, `npm run lint:listings`, in CI: a literal `limit` above one reaching a single-page list call fails the build unless the line says `listing-bound:` and why. Two bounds are declared today; both are exact-path lookups, not collections.

- 6234d55: test: a live exemplar proves a cohort answers for every patient asked

  Exemplar 11 drives the whole PACS plural path through `command_dispatchEnvelope` — the same entry chell uses — against a live CUBE and a real PACS.

  What it pins, in the order an operator would care:

  - **Every MRN asked has a row.** It counts rows, not hits: the answer an audit wants is usually the patients a hit-list would hide.
  - **Replay applies per patient.** The second ask of the same cohort is served from stored answers for the patient with imaging — same query id, provenance saying so — while the rows that found nothing are asked again, because an absence decays where a hit does not.
  - **A failure is not a miss.** Asked of a server CUBE does not register, the rows read `unasked` with a readable reason rather than zero studies. This is the property that needs a live PACS: a mock would only agree with whatever the code already does.
  - **The CSV round-trips.** `--csv-to` writes into CFS, `cat` reads it back, every row carries the same ten columns, and the misses are in the file.

  It needs no new fixture: the designated test accession names a study, that study names a patient, and that patient is the MRN known to have imaging. Every PACSQuery the run creates is deleted and the file removed, so the CUBE ends as it began. Self-skips with exit 2 where no PACS fixture is configured, and joins the nightly e2e list.

  One fix it drew out: the query model named its server with the raw `--pacsserver` argument, so a table asked with `--pacsserver 1` reported the server as `1`. The model now carries the canonical identifier CUBE files queries under, which is what `PACSDCM` means to an operator reading a CSV.

- 17964a9: fix: no write goes to a path the store already holds

  A write onto an occupied path leaves a row CUBE's own API cannot serve, and one such row makes **every** listing of that folder fail — the damage first seen as "the home root cannot list its files". It is reproducible in three commands, and all three ordinary write routes did it:

  - `mv a b` where `b` exists — its own PUT of `upload_path`.
  - `cp a b` where `b` exists — the copy uploads to an occupied name, and reported _success_ while doing it.
  - `upload a.txt` where `a.txt` exists — and this is the one that made the original rows. CUBE renames a colliding upload (`a.txt` → `a_VlIxMSp.txt`); mise then PUT the wanted path back onto the file, to undo a rename it read as spurious. That PUT is the damage.

  Each route now asks first, which costs one listing call and keeps the folder readable:

  - `mv` and `cp` refuse by name — `Destination exists: <path> — mise cannot overwrite a file; remove it first` — and a failed move or copy now reports the kernel's own reason instead of a bare `Failed to move` / `Failed to copy`.
  - `upload` renames back only when the wanted path is genuinely free, which is the case that rule was written for (a path deleted and not yet committed). Otherwise it keeps the name CUBE gave the file and says so: `'<path>' already exists — the upload landed as '<other>' rather than overwriting it`. A probe that cannot answer counts the path as taken, since the cost of guessing wrong is the operator's folder.

  The deliberate replace (`--csv-to --force`) is unaffected: it removes the file, waits for the path to stop resolving, then writes to a path that is free.

  `docs/CUBE-gaps.adoc` carries the reproduction, the mechanism and the client policy; upstream is ChRIS_ultron_backEnd#732.

- Updated dependencies [f5c16fe]
- Updated dependencies [116e8ba]
- Updated dependencies [ec3ef9f]
- Updated dependencies [7181f7e]
- Updated dependencies [d2a4315]
- Updated dependencies [a245b5f]
- Updated dependencies [5a339f0]
- Updated dependencies [17964a9]
- Updated dependencies [62761a3]
- Updated dependencies [17964a9]
  - @fnndsc/salsa@3.13.0
  - @fnndsc/cumin@3.18.0
  - @fnndsc/menu@0.4.0
  - @fnndsc/chili@3.6.6

## 0.16.1

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

## 0.16.0

### Minor Changes

- 5dc064e: feat(boot): warm-up leaves the gate, and a failure that leaves it is still heard

  Boot blocked on four prefetches in front of the prompt. Measured against a live CUBE, `/PUBLIC` costs 8.4 seconds and `/SHARED` 9.3 — roughly eighteen seconds an operator spent watching a prompt that was already theirs, buying freshness the stale-serve path delivers a moment later anyway, since the checkpoint restore has already put those listings in the cache.

  Boot now blocks only on `/bin`, which completion cannot work without: an empty completer reads as a broken prompt rather than a fast one. Groups, Feeds, Public and a newly added `/SHARED` step warm behind the prompt under a new `PENDING` boot status. They keep their bounded retry policy; a transient failure should be retried before it is announced.

  `/SHARED` had no step at all before. That is where another identity's work becomes visible, and with nothing to fail, a CUBE that stopped serving shared paths stayed silent until somebody went looking.

  **A deferred step leaves the boot failure gate**, so its failure can no longer stop a daemon binding — and a boot readout has scrolled away by the time it arrives. The failure is held until a later attempt succeeds and carried on the prompt context, so every surface says it: chell's prompt reads `[warm-up failed: groups]`, and argus names it on the JOBS readout in mars with the reason on hover. Named rather than counted, because "Groups" tells an operator which capability is degraded where "1 warm-up failed" only tells them to go looking.

  Nothing reports a deferred completion. A warm that finishes and changes nothing is not news.

  Carries AEGIS law `deferred-warmup-failure-persists` with its smoke, which drives the surface's real prompt-context path rather than asserting a stub.

- eaf6c67: feat(acl): a feed's access list, in the shell's own verbs

  An exemplar needed to share a feed and mise had no wrapper, so it reached past the stack to CUBE's REST. That is backwards: a missing wrapper is the work. A capability living in one caller's private REST call is invisible to every other surface and untested by the kernel's suite.

  The kernel gains `feed_share` and `feedShares_list`, over the client's own `addUserPermission` and `getUserPermissions` — which existed all along, so no raw REST was ever needed.

  Its shell face is `setfacl` and `getfacl`, not a `share` verb. Granting an identity access to a thing is an access control entry, and that is a verb a terminal already knows; "share X with Y" is a sentence, and reads as a natural-language assist rather than a shell:

  ```
  setfacl -m u:someone:r /home/me/feeds/feed_12
  getfacl /home/me/feeds/feed_12
    # file: home/me/feeds/feed_12
    user::rw-
    user:someone:r--
  ```

  A feed is named by id, by the `feed_N` a listing shows, or by any path holding one, so a path under `/SHARED` resolves by the same rule as one under a home folder. Group and other entries are refused rather than quietly read as users, an entry granting no read is refused because reading is what a CUBE share conveys, and `-x` is refused **by name** — CUBE models the grant but mise has no revocation to offer, and a shell that appears to strip an entry it cannot strip is worse than one that says so.

  The grammar sits in its own dependency-free module, as `cat`'s does: the engine graph cannot be loaded under jest, so a grammar inside the builtin is a grammar nothing tests.

- 73aa61a: The feed roster (`proc feeds`, the RUNS pane) reports each resident feed's total output size and wall span, derived from the cache with no wire; `cd` into a CFS link now follows it to its target, and a refusal names that target.

### Patch Changes

- 75f1e5f: fix(boot): a step's label stops moving when it finishes

  A boot step is announced while it runs and again when it settles, and the two lines disagreed about where the label starts. The running line hardcoded a five-space indent against a comment asserting `[ OK ] ` was seven characters wide; the finished line pads its tag to the widest tag and adds a space. The label therefore jumped a column as each step resolved, and the plain non-interactive log was out by three rather than one.

  The indent is now derived from the host's own tag width and from whether a spinner glyph precedes the text, since an animated line draws a frame and a space of its own and owes only the remainder while a plain log line owes the whole column. `chell` passes the width it actually renders with, so a longer status added later moves both lines together.

  The arithmetic lives in its own import-free module, because the wider engine graph cannot be loaded under jest and an untestable alignment rule is how the first version came to be wrong.

- 4f034b9: Host control: `chell --daemon --host-control[=shell,files,pipes]` lets the daemon declare capabilities of its own — `!` runs on the daemon host, pipe segments run there, `upload`/`download` reach its disk — off by default, refused on a non-loopback bind without `--expose-host-control`, and annunciated everywhere (attach ack `hostControl`, the daemon face, the prompt's HOST segment, a remote shell's banner). Without the `files` tier, `upload` under a daemon now refuses instead of reading the daemon host's disk.
- aa25502: The process cache records the compute resource each plugin instance ran on (from the CUBE list row), and the `feed.dag` model carries it per node (`mixed` for a group whose members ran on different resources), so a surface can hue a graph by where its work ran.
- f8d1b1c: Index movement is annunciated: a feed's first-visit topology load (`feed 812 indexing: 3400/20000 17%`) and roster arrivals (`+feed 812`, feeds created since or newly shared) reach the prompt context's `procWarmup` segment — `feed`, `arrived`, and `sweeping` so a renderer can tell a sweep from a load — and the chell prompt renders both. The process cache keeps the two registers (`feedLoad_progress/clear/get`, `arrivals_note/recent`); the salsa feed walk and roster syncs feed them.
- Updated dependencies [f73e6c2]
- Updated dependencies [5dc064e]
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
  - @fnndsc/salsa@3.12.1

## 0.15.0

### Minor Changes

- 920e0ac: The `feed.dag` wire model is now the COLLAPSED projection: isomorphic sibling subtrees merge into one ×N node (the terminal tree's own collapse transform), so a massive fan-out crosses the wire and reaches a rendering surface as its shape, not its census. Each collapsed node keeps a real representative instance (id and data address), wears its worst member's status (an error anywhere in the group is visible on the node that stands for it), sums member metrics, and carries a tally with jump-to-error anomaly ids.
- c716624: Directory listings survive a restart. The listing cache is checkpointed (identity-keyed file under `~/.cache/chell/vfs/`, throttled writes) and restored at boot with each entry's original timestamp, so a restored listing is exactly as stale as it really is. Stale handling itself is fixed: the listing path used to serve any cached entry regardless of its TTL (a listing never refreshed until eviction or `ls -f`). Now a fresh entry serves as is; a stale one is served at once and revalidated behind itself when a host can carry the refresh (the daemon publishes the fresh `fs.listing` on the ambient bus, marked `fresh`), and is refetched in line at a plain console. `ls` models carry `fresh` per listing; `vfs.listing_get` exposes the listing with its freshness.
- 97af423: Watches: a surface can keep a running feed live. New wire pair `watch` / `unwatch` (subject = `/proc/jobs/feed_N`, owned per surface, released on detach) and a `watched` report (`live` | `settled` | `stale`). While anyone watches a feed the engine samples it on an adaptive cadence (3 s while it changes, backing off to 30 s when quiet), and whenever a visit changes the cache it publishes the refreshed `feed.dag` model to every surface as a session-bus envelope from the `daemon` surface, off the scrollback. A feed that settles reports `settled` and the watch ends; a failed sample reports `stale` and keeps trying. `proc watch <feed>` / `proc unwatch <feed>` are the console forms (`proc watch` lists). The engine gains an ambient event bus for events it originates on its own. Feed visits within one second of each other now share one sync, and `feedVisit_sync` reports whether it succeeded.

### Patch Changes

- cece0dc: `/proc` freshness is now visit-driven. A revisit to `/proc/jobs/feed_N` (or a `feed diagram` re-render) is a delta, not a re-crawl: one feed-row fetch, and only when the job counters moved, a `min_end_date` walk of the nodes created or finished since the last visit plus an `active=true` sweep of the nodes still running. Nodes a dynamic pipeline spawns after the first load now appear on the next visit; previously they were invisible until `proc refresh`. Settled feeds are re-checked at most once per ten minutes, so work appended to a finished feed is still seen. A `/proc/jobs` visit (and `proc feeds` / `proc jobs list`) picks up feeds newer than the highest known id, and walks the whole index once the roster is older than ten minutes, so a feed shared later still appears.
- Updated dependencies [920e0ac]
- Updated dependencies [7a0f06e]
- Updated dependencies [c716624]
- Updated dependencies [cece0dc]
- Updated dependencies [97af423]
  - @fnndsc/cumin@3.16.0
  - @fnndsc/salsa@3.11.0
  - @fnndsc/menu@0.2.0

## 0.14.1

### Patch Changes

- 1bc0953: `ls` on a ChRIS link (`~/public`, `~/shared`) follows the link instead of rendering the link entry itself: the parent-cache leaf shortcut no longer captures links, so resolution falls through to the dispatcher's PathMapper. Native listings are also name-deduplicated (CUBE's links search can return the same row twice, observed on /PUBLIC).
- Updated dependencies [44ba77a]
- Updated dependencies [1bc0953]
  - @fnndsc/cumin@3.15.1
  - @fnndsc/salsa@3.10.1

## 0.14.0

### Minor Changes

- 85791b3: `config write <cfs-path> <base64>` — the durable layer's write path.

  Per-user surface state (argus desktops, and the config-in-CFS family to
  come) lives as files under `~/.config/...` in the user's CUBE home. Reads
  were always `cat`; this adds the write: content arrives base64-encoded,
  stages through a host temp file, and rides the same upload
  (replace-in-place on an existing document) the edit flow uses. Documents
  are notes, not datasets: 256KB limit.

## 0.13.0

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

- 31c2a50: `pipeline diagram` and `feed diagram` now carry their graphs as typed
  envelope models: `pipeline.diagram` (the authored topology) and `feed.dag`
  (the live instance graph with statuses and each node's `/proc` data
  address). The rendered trees are unchanged; a graphical surface reads the
  model where a terminal reads the text — one command, two projections.
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

- e062dbf: Two more commands speak in models: `proc feeds` (now listing the whole
  cache-resident roster when unqueried) carries a `feed.list` model, and
  `pacs query` carries a `pacs.query` model — studies and series with their
  instance UIDs and pullable VFS paths. Terminal renderings are unchanged.
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

- 1d600ac: An archive that cannot run no longer leaves a feed behind, and says the right
  reason for not running.

  Live testing found both. `download <dir>` from a browser reported that the
  `zip v20240311` pipeline was not registered, directly below a line explaining
  that one of its nodes was not registered on the target compute environment. The
  pipeline was present; the advice to fetch it from the store was wrong. Every
  `pipeline_run` failure had been collapsed into the one message.

  `pipeline_readiness` in salsa answers whether a pipeline exists and could be
  prepared, distinguishing _unregistered_ from _registered but unpreparable_ —
  different problems calling for different actions.

  Preparing a pipeline needs no previous instance, so readiness is now checked
  _before_ the feed is created. The failed run above had already created a feed
  that nothing then used, leaving litter in a feed list and a copy in the compute
  graph asserting an analysis that produced nothing.

  A run that fails after its feed exists now removes it, and names the feed when
  removal fails. A run that merely exceeds its time limit is left alone, since it
  may yet finish and deleting would remove the feed from under a running job.

- 1c195a7: Execution metrics ride the warmup for free: node differentiation lands.

  Every CUBE plugin-instance list row already carries `start_date`,
  `end_date`, and `size` — the same rows warmup and status refresh page
  through. They are now typed on the contract, captured into the proc cache
  (`ProcInstance.startedAt/finishedAt/outputBytes`, merged defined-only so a
  refresh never erases what warmup saw), persisted by the checkpoint, and
  projected by `feed diagram` onto each node's `metrics` (wall-clock
  `computeSeconds`, `dataBytes`). Zero new CUBE calls at any point.

  The molecule rendering scales by them (a SCALE pill flips between wall
  time and output bytes, re-projecting the remembered model locally), and
  timestamp-true pulse replay becomes possible.

- 87f7c59: The `pacs.query` model now says what CUBE already holds: each series carries
  a `pulled` flag and file count (one bounded sweep of single-attempt lookups),
  and studies carry their own VFS path so a surface can pull a whole study.
- 3125517: A dropped retrieve watch is no longer reported as a failed pull.

  Pulling a 22-series study reported `0/22 series complete` with every series
  marked `ERROR` — and the CUBE path report printed immediately below it listed
  four of those same series with real paths and file counts. The retrieves were
  fine; the watch had died.

  One websocket failure marked every in-flight series `error`, because
  `RetrieveStatus` had no value meaning _the client stopped watching and does not
  know the outcome_. The code knew the difference — a comment in `pull` says a
  watch failure "is usually cosmetic, the PACS keeps pushing and CUBE keeps
  registering after detach" — but nothing downstream acted on it.

  A lost watch now marks its series `unconfirmed`. The confirmation loop, which
  already asks CUBE about series whose confirmation went missing, now asks about
  these too: a series CUBE reports as stored is `pulled`, with its file count and
  path, whatever the watch managed to see.

  What remains unconfirmed is reported as unknown rather than lost — `? … [WATCH
ENDED — may still be arriving]` — and does not fail the command, because
  nothing in the client knows that it failed. A series that was never fired is
  still a real failure and still fails the command.

- b39b584: A dropped retrieve watch reconnects instead of giving up.

  The LONK socket is only how a client watches a retrieve; the retrieve itself
  runs on the server and is unaffected by the socket dying. Losing the view was
  nonetheless the end of the watch — which is why a 22-series study failed where
  a 2-series one did not: a longer retrieve gives the socket more chances to
  drop.

  A dropped socket is now reopened, up to three times, and re-subscribed to the
  series still in flight. Nothing is re-fired: those retrieves were never lost.
  The reconnection is announced, because a silent one during a long pull is
  indistinguishable from a stall.

  Only when reconnection is exhausted does the watch stop, and it still records
  the remaining series as `unconfirmed` rather than failed.

- Updated dependencies [1d600ac]
- Updated dependencies [a78b5ee]
- Updated dependencies [1c195a7]
- Updated dependencies [e58bf58]
- Updated dependencies [56ade16]
- Updated dependencies [2bb9c29]
- Updated dependencies [3125517]
- Updated dependencies [2c38d8b]
- Updated dependencies [b39b584]
  - @fnndsc/salsa@3.10.0
  - @fnndsc/cumin@3.15.0

## 0.12.0

### Minor Changes

- 0ad04f2: The engine can now hand raw file bytes to a hosting daemon: brasa's `BrasaEngine` gains an optional `file_read(filePath)` that resolves a ChRIS VFS path to a `Buffer` through chili's binary cat. Calypso's daemon exposes it as a token-gated `/vfs?path=&token=` HTTP route with extension-derived content types, letting a web surface render images and other binary content that a text transcript cannot carry.

## 0.11.1

### Patch Changes

- b0b478b: PACS payload and path-grammar consolidation. Cumin gains `dicomPayload`, the one home for DICOM query-payload interpretation (tag unwrapping including the DICOM-JSON `{Value: [...]}` form, study and series array location, UID lookups), replacing four diverged private copies. Salsa's `pacsHelpers` becomes the single authority for the PACS folder grammar, adding `folderUID_get`, `queryLabel_extractFromFolder`, and `queryFolderName_build`; the query path a surface builds now always matches the name the listing shows, including the title fallback the old builder lacked. Brasa's `pacsUtils` and `query` builtins consume the shared helpers; `pacs_tagValueExtract` remains as a compatibility alias.
- Updated dependencies [b0b478b]
- Updated dependencies [bb4e06a]
  - @fnndsc/cumin@3.12.0
  - @fnndsc/salsa@3.8.0

## 0.11.0

### Minor Changes

- 69b0617: Typed chell API, third tranche: `cp` and `mv` join the facade with their
  existing `fs.cp`/`fs.mv` models. Fixing what their first typed run
  surfaced: file rename was silently broken against current CUBEs (the PUT
  field drifted from `path` to `upload_path`); cumin now sends the current
  field and falls back for older servers.
- 7ed8e1c: Typed chell API, second tranche: `ls` and `cat`. `ls` gains the
  `fs.listing` model (entries per target as data), `cat` joins with its
  existing `fs.cat` outcomes and content in the rendered channel, and both
  enter the same cores the parsed builtins enter. Programmatic `cat` never
  injects syntax highlighting.
- 7dc3bca: The typed chell API, first tranche. `chellApi_create()` returns the shell's
  vocabulary as function calls: `pwd`, `cd`, `mkdir`, `touch` and `rm` take
  typed options, enter the same per-command cores the parsed builtins enter,
  and return envelopes whose model slot is typed per command
  (`TypedEnvelope<K>` over the new `FsModelMap`). No command line is
  assembled or parsed anywhere on the path.

### Patch Changes

- Updated dependencies [14f8ee8]
- Updated dependencies [4da2673]
- Updated dependencies [69b0617]
  - @fnndsc/cumin@3.11.0
  - @fnndsc/salsa@3.7.0
  - @fnndsc/chili@3.6.5

## 0.10.1

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

## 0.10.0

### Minor Changes

- 22db63f: Make PACS pulls observable and recoverable. A new `pacs status <expression | path | queryId>` reports one line per series: a fill bar of files registered in CUBE against the PACS-reported instance count, the derived state, and the in-CUBE `/SERVICES` folder for every landed series; an expression reuses the caller's most recent matching query instead of minting a new record per check. `pull` is now idempotent: series already fully registered in CUBE are skipped before firing, so re-running the same pull fetches exactly the missing series. Retrieve firing gets three attempts with backoff and is bounded to four concurrent creations, replacing the all-at-once stampede that overloaded CUBE and silently lost retrieves. A series whose firing still fails is reported as `FAILED TO FIRE, will not arrive; re-run pull`, distinct from watch-side failures, which now point at `pacs status` since their transfers usually complete server-side anyway. Cumin's status report gains the per-series storage folder (`seriesStorage_resolve`). The failure modes and operator playbook are documented in docs/pacs-pull-recovery.adoc.
- 590a943: Converge the two PACS retrieve watchers onto one engine. pull's battle-tested LONK machinery (bounded, retried firing; stall/timeout/no-activity detection; storage confirmation; refire loop) moves into salsa as the presentation-free `retrieve/watch` module; the `pull` builtin becomes a thin consumer rendering engine events onto its sink, and the PACS VFS provider's `cp` drops its 5-second polling watcher for the same engine, gaining firing retry, LONK push, and the idempotency skip. The convergence surfaced and fixed two latent defects that had made PACS `cp` unusable on real paths: the source parser assumed paths without the `/queries/` segment and rejected every real listing path, and the file downloader only consulted the userfiles collection, so PACS files under `/SERVICES` read as "not found"; it now falls back to the PACS files collection. Supporting dedup: cumin gains `retry_untilValue` (the one bounded-backoff loop) and `seriesStorage_resolve` gains bounded re-probing, replacing the per-package storage-resolver copies; the `_qid:` parser is now shared from salsa.
- b2f5ad3: Greet every surface with the stack's identity. Builds now record the short git hash they were produced from (`dist/buildinfo.json`, written by the new `scripts/buildinfo.mjs` build step), and brasa exposes it through `buildHash_get` alongside `welcomeLine_build`/`welcomeLine_compose`, which render a banner of the form `ChELL Executes Layered Logic, v 5.3.0 (886f09). Welcome.` An interactive chell session prints the banner and a short fortune at boot, the calypso daemon announces its banner plus an aligned version line for every stack layer (chell, brasa, chili, salsa, cumin, calypso) when it starts listening, and the attach handshake gains an optional `stack` field carrying all six versions and the build hash, so a remote surface banners the daemon's full reported stack rather than its local install's. `fortune_random` is exported for reuse, with an optional line-count bound so banners favour short cookies.

### Patch Changes

- 2e60785: Cache the `/etc/group` projection per CUBE connection for five minutes,
  invalidate it after ChELL membership changes, and show semantic inspection
  progress while an uncached projection is resolving.
- 66bc932: Add ChELL group membership commands and include current CUBE usernames in the
  live `/etc/group` projection.
- 8ec8a4b: Add explicit, command-scoped CUBE elevation with `sudo <command>`. The active surface collects an administrator identity and hidden password; a temporary CUBE client runs only the nested command, then the normal session is restored. Group membership and plugin registration now suggest a copyable `sudo` rerun after an authorization failure, and plugin registration no longer owns a separate interactive admin prompt.
- d0ac04f: Preserve failure causes and tighten cache contracts. Errors that were replaced by generic messages now carry their real cause: controller and handler creation failures name the underlying error instead of "no ChRIS context", `cat` shows the actual fetch failure, docker command failures surface stderr detail, context-set errors actually print, settings load/save failures are announced instead of silently using defaults or losing changes, unreadable berth and discovery files are named instead of reading as "no daemon", token-file read errors are distinguished from the logged-out state, and resource deletes report why they failed. Every remaining deliberate error absorption now carries a dated adjudication comment. Cache contracts: the PACS provider's decoded-query cache caches settled results only and is size-bounded; the object-context factory gains an eviction hook (`objContext_evict`) for deleted plugin or feed ids; `mv` and `cp` invalidate the whole affected listing subtree; and a new PACS query invalidates the cached `/net/pacs/queries` listing so it appears in the next `ls` immediately.
- 886f09c: Fix stale directory state in long-lived daemons. Folder object contexts are no longer cached in the cumin context factory: folder paths are not stable identities in CUBE (deleting and re-uploading a directory assigns a new folder id), so a group bound at first touch kept serving the dead folder for the life of the process, which in a calypso daemon meant a freshly uploaded directory listed as permanently empty and `ls -f` could not recover it. Plugin and feed contexts keep their stable-id cache. The listing cache gains `cache_invalidateTree`, and `rm` and directory uploads now invalidate the whole affected subtree, so a delete-and-re-upload cycle cannot serve still-fresh nested listings from the old tree. The salsa native provider also distinguishes a missing folder from an empty one: when every sub-listing comes back empty it probes the parent, and a nonexistent path reports "No such file or directory" instead of rendering as an empty directory.
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
- Updated dependencies [50e9bb1]
- Updated dependencies [d0ac04f]
- Updated dependencies [22db63f]
- Updated dependencies [0e92d4d]
- Updated dependencies [590a943]
- Updated dependencies [fa81126]
  - @fnndsc/salsa@3.6.0
  - @fnndsc/cumin@3.9.0
  - @fnndsc/chili@3.6.2

## 0.9.9

### Patch Changes

- Keep `cat /bin/<pipeline>` immediate with a cache-only executable summary;
  move complete registered invocation YAML and delayed inspection progress to
  `pipeline manifest <specifier>` and `<pipeline> --manifest`.
- Updated dependencies
  - @fnndsc/salsa@3.5.5

## 0.9.8

### Patch Changes

- Emit delayed semantic progress when an exact `/bin` Pipeline manifest read
  takes longer than 300 milliseconds, while leaving fast cache hits silent.

## 0.9.7

### Patch Changes

- Resolve exact `/bin` Pipeline reads without global Pipeline enumeration or
  per-node hosted-plugin metadata requests, cache repeat reads, and render
  Pipeline topology in linear time.
- Updated dependencies
  - @fnndsc/salsa@3.5.4

## 0.9.6

### Patch Changes

- Run registered pipelines with node-qualified parameters, compute/resource
  controls, and strict CFS YAML overlays; expose registered manifests through
  `/bin`, contextual parameter help, and completion.
- Attach one plugin or pipeline after `pacs pull --new-feed`, preserving the
  valid Feed and root when attachment fails.
- Preserve shell-tokenized spaces, negative values, booleans, and `--name=value`
  across plugin and pipeline executable arguments.
- Updated dependencies
  - @fnndsc/cumin@3.8.4
  - @fnndsc/salsa@3.5.3

## 0.9.5

### Patch Changes

- Add `pacs pull --new-feed "TITLE"` to create one named analysis feed from a
  completely retrieved PACS selection, with explicit feed/root IDs and
  all-or-nothing handling for partial or unresolved pulls.
- Updated dependencies
  - @fnndsc/cumin@3.8.3
  - @fnndsc/salsa@3.5.2

## 0.9.4

### Patch Changes

- Add controllable syntax highlighting to `cat`, including Python and other
  popular source/configuration formats, while keeping ordinary pipes and
  redirects ANSI-free.

## 0.9.3

### Patch Changes

- Carry cold, cached-refresh, and failed `/proc` lifecycle state through the
  CALYPSO prompt contract; reorder p10k segments and render distinct lifecycle
  clues for local and remote surfaces.
- Updated dependencies
  - @fnndsc/cumin@3.8.2

## 0.9.2

### Patch Changes

- 6f0833a: Release the coordinated ChELL stack with deterministic `/proc` topology progress, complete visible-feed indexing, safe warm-up query gating, remote one-shot command completion, and refreshed daemon documentation.
- Updated dependencies [6f0833a]
  - @fnndsc/cumin@3.8.1
  - @fnndsc/salsa@3.5.1
  - @fnndsc/chili@3.6.1

## 0.9.1

### Patch Changes

- 71a6cd4: Route a pipeline executable's bare `--signalflow` flag to SignalFlow diagram output and provide contextual help for dynamic pipeline commands. Keep final-segment redirection on the originating surface, propagate remote pipe-segment failures back to the engine, and prevent remote command errors from terminating the interactive ChELL client. Daemon mode now reports shared startup cache warming and publishes its listening berth only after engine readiness. Consistently document `signalflow -` for stdin rendering.

## 0.9.0

### Minor Changes

- e630f79: Draw registered CUBE pipelines with `pipeline diagram <id|name>` or the `/bin` shorthand `<pipeline> --diagram`. Bare output uses the same shallow tree machinery as feed diagrams, `--withargs` appends stored non-null plugin defaults, and `--signalflow` emits the same SignalFlow YAML dialect as feeds. `feed diagram <specifier>` is now a shallow alias of `feed tree`; feed graph commands accept IDs, `feed_N`, exact or unambiguous title searches, and infer the feed from the current `feed_N` directory when omitted.

### Patch Changes

- e630f79: Classify CALYPSO as the assisted session host, rather than a user-facing surface, in the detailed stack information report.
- Updated dependencies [e630f79]
  - @fnndsc/cumin@3.8.0
  - @fnndsc/salsa@3.5.0

## 0.8.0

### Minor Changes

- 8ac7ef9: Add `feed diagram --signalflow <feedId>` — emits a feed's DAG as a **SignalFlow YAML
  document to stdout**, composed with pipes rather than rendered in place:

  ```
  feed diagram --signalflow 1669 | signalflow -            # ASCII
  feed diagram --signalflow 1669 | signalflow - -o x.svg   # SVG
  feed diagram --signalflow 1669 > feed-1669.yaml          # keep it
  ```

  It builds the graph cache-first, collapses isomorphic siblings into named `×N` chips, and
  encodes topological-join edges via SignalFlow's node-reuse mechanism. mise emits the
  representation only — no renderer is invoked, discovered, or bundled — so there is nothing
  to install for the command itself; rendering is the user's own `signalflow`. `--signalflow`
  names the dialect, leaving room for further emitters (`--json`, `--dot`, …).

## 0.7.0

### Minor Changes

- b8ae635: `feed tree` now collapses isomorphic sibling subtrees by default. Structurally-identical
  branches merge into one `×N` template node showing a proportional status bar, per-category
  counts (`97✓ 2⋯ 1✗`), and the ids of any non-done members (error first) so failures stay
  addressable. Collapsed groups use a double-line connector to signal multiplicity. Pass
  `--flat` to draw every node individually.
- ca63e8b: Add `feed tree <feedId>` — renders a feed's plugin-instance DAG as an annotated text
  tree. The anchor tree is drawn with box-drawing connectors; topological-join (`ts`) nodes
  are annotated inline with the extra sources they merge (`⋈ joins ...`). Supports
  `--focus <id>` to scope to a subtree and `--max-nodes <n>` to cap output (0 = all). The
  envelope carries a typed `feed.tree` FeedGraph model.

### Patch Changes

- 01ab743: `feed tree` now builds the DAG **cache-first** from the warm ProcCache instead of
  re-crawling the feed on every call. It reuses already-loaded topology, fetches feed
  metadata only when missing or a placeholder, refreshes volatile status cheaply (one
  feed-scoped list call, active nodes only) when reusing a warm cache, and resolves join
  edges lazily. New salsa exports: `feedGraphData_ensure`, `feedMeta_ensure`,
  `feedInstances_ensureLoaded`, `feedStatus_refresh`.
- Updated dependencies [a1f6694]
- Updated dependencies [01ab743]
  - @fnndsc/cumin@3.7.0
  - @fnndsc/salsa@3.4.0

## 0.6.1

### Patch Changes

- 0d358c5: /proc now caches settled job status. A finished plugin instance
  (`finishedSuccessfully`, `finishedWithError`, `cancelled`) never changes, so its
  status is kept permanently once observed. Consequences:

  - Listing a fully-finished feed under `/proc/jobs` is instant — no status calls.
  - Live status for active feeds is refreshed with a single feed-scoped list call
    (the list response already carries `status`) instead of one detail fetch per node.
  - Reading a settled instance's `status` returns the cached value without an API call.

- Updated dependencies [0d358c5]
  - @fnndsc/cumin@3.6.0
  - @fnndsc/salsa@3.3.0

## 0.6.0

### Minor Changes

- e5a30f7: Add `date` and `cal` builtins, in the spirit of their UNIX namesakes and fully self-contained (pure computation — no host binary, no subprocess). `date` prints the current date/time with the familiar default format, `-u` for UTC, and `+FORMAT` strftime-style format strings (it reports the time only, never sets the clock). `cal` prints a month (`cal`), a whole year (`cal <year>`), or a specific month (`cal <month> <year>`), with today highlighted. Both return their output in an envelope through the sink, so they work identically local, over a CALYPSO daemon, and in the standalone binary.

## 0.5.0

### Minor Changes

- c2087d0: Add a `fortune` builtin — the classic UNIX fortune cookie, as a shell builtin. It prints a random fortune and is fully self-contained: the content is bundled (vendored from the traditional fortune-mod datfiles, classic BSD `fortune` material), so it needs no host `fortune` binary and no datfiles on disk, and behaves identically in a local shell, over a CALYPSO daemon, and in the standalone binary. Output travels in an envelope through the sink like every other command. Regenerate the bundled set with `scripts/fortunes_generate.mjs`.

## 0.4.0

### Minor Changes

- 880d37a: `chell --version` reported brasa's version in place of chell's: the version module moved into brasa during the engine split but still read its own `package.json` as "chell", so it printed brasa's number. It now resolves every package by name (reading brasa's own directly) and reports the full stack — chell, brasa, chili, salsa, cumin, calypso — with versions aligned in a column. A new `chell --info` flag prints a role-grouped table (surfaces / engine / layers) of each package, its full name, and version. The version report, the `--info` table, and the boot panel all draw from a single source of truth in brasa (`stackInfo_get`), and the standalone binary inlines every stack version at build time.
- e43f42a: Delegating an unknown chell command to chili no longer stalls or floods the terminal with context-init errors when the current directory is a pure-VFS path (`/proc`, `/net`, ...). chili now registers its file-group and plugin-context commands without resolving any ChRIS context — each controller is created lazily, only when a command's action runs — so an unrelated command (or a directory that is not a ChRIS folder) pays no network cost and produces no setup-time error wall. chili also exports `commandNames_get()`, a cheap network-free listing of its top-level commands. In brasa, the "delegating to chili" notice is now emitted on the live sink before chili runs, so it appears ahead of chili's output instead of after it; and a command chili does not know (a typo, a host program) is reported as `command not found` without delegating at all.

### Patch Changes

- 512e14f: Fix `<command> --help` leaking to a daemon's terminal instead of reaching the surface. The `--help` flag path printed help through `console.log`, which on a CALYPSO daemon landed on the daemon's own terminal — and returned an empty envelope, so a remote surface saw nothing. Help now travels in an envelope through the sink like every other command output, so `--help` reaches the surface that asked for it and never prints on the daemon. This removes the last console-based path in the help flow (`help_show`).
- Updated dependencies [e43f42a]
  - @fnndsc/chili@3.6.0

## 0.3.0

### Minor Changes

- a0d3df5: The engine no longer intercepts the console anywhere. The pipe/redirect `output_capture` monkeypatch is deleted: pipes now capture through a `PipeCaptureSink` scoped over the (re-activated) `AsyncLocalStorage` sink scope, ANSI-stripping text writes and keeping binary writes (a raw `cat` of a DICOM file) byte-for-byte. `chiliCommand_run` drives chili through its `run_capture` seam and returns an envelope, so the pacs passthroughs and the unknown-command fallback are envelope-based. The remaining print-direct builtins are converted: `store`, `upload`, `download`, `connect`, `edit` return envelopes, while the streaming commands `pull`, `pipeline`, and `pacs` emit incremental output through the sink so it streams live to a terminal or daemon and is captured in a pipe.

### Patch Changes

- Updated dependencies [a0d3df5]
  - @fnndsc/chili@3.5.0

## 0.2.0

### Minor Changes

- d69b086: Every printing builtin now returns a `CommandEnvelope` instead of writing to the console. `files`/`links`/`dirs`, `feed`, `plugin`, and `parametersofplugin` were the last holdouts; with them converted, the per-invocation console monkeypatch (`printingHandler_wrap`, which hijacked `console.log`/`console.error`/`process.stdout.write` to capture a builtin's output) is deleted, along with the `LiveEnvelopeOutputSink` marker that only served it.

  Behavioural notes: unknown subcommands of these resource commands now return a clear error envelope instead of spawning a chili subprocess, and `search` is handled natively via `list --search`. The unknown-_command_ fallback still delegates to chili, now over the same print-direct path as the other unconverted handlers.

### Patch Changes

- Updated dependencies [d69b086]
  - @fnndsc/chili@3.4.0
