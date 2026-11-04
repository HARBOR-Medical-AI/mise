# @fnndsc/salsa

## 4.4.4

### Patch Changes

- e282d3a: A /proc/jobs path naming one feed resolves that feed alone on a fresh session, while the index builds behind.

  `ls /proc/jobs/feed_N` and a `cd` into a node's `data` waited on the whole feed index (minutes on a tenancy with many feeds) before answering (#1364). A path naming one feed now reads that feed's row and topology and answers; `/proc/jobs` itself still needs the index. `workflowFeedIDs_get` asks CUBE which feeds a workflow's jobs are in, for a search scoped to one run.

## 4.4.3

### Patch Changes

- c742135: An identity that sees thousands of feeds can log in again: the boot no longer waits on CUBE's slow feed list (#1280). The token check reads `users/` instead of the API root, which is the feed list and took up to 22 s for `chris`; a CUBE that does not answer the check is said to be silent, never to have refused the token. Each client reads its root once for every caller, and feed-list pages wait 120 s instead of chrisapi's 30. A cold boot walks the feed index behind the listening daemon, as a restored one already did, so the session answers the door before its 120 s wait runs out; a `/proc` read that arrives first joins the walk instead of starting a second.
- Updated dependencies [c742135]
  - @fnndsc/cumin@3.29.4

## 4.4.2

### Patch Changes

- e12598c: Finding jobs by pipeline run is complete about seven times sooner on a large account (#1253). Which pipeline run made each job is read again, behind the prompt, for jobs an older checkpoint lacked, and that read took hours.

  The jobs it lacks sit in a few big feeds (on one account three feeds held all 118k), and they are each feed's older jobs: CUBE lists a feed newest first, and an earlier pass had already learned the newest. The read now starts each feed where the unknown jobs begin instead of at its head, reads pages in parallel across all its lanes instead of one feed page after page, and reads a feed whole when the skip missed any. Measured on that account: about 5,000 jobs learned a minute, from about 700.

  `proc stat` says how far it has come while it reads: `pipeline runs : reading behind the prompt, 155/1061 pages`.

## 4.4.1

### Patch Changes

- eba14cc: A folder you just removed no longer comes back in `ls`. CUBE accepts a folder's removal (202) and finishes it a moment later; until then its parent still lists the folder, and a listing read in that moment (the `ls` after `rm -r`, a pane's refresh) was kept as current, so the removed folder stood in `ls ~` for as long as the cache trusted that listing.

  `rm -r` and `rmdir` now return once CUBE has finished: they wait, 15 seconds at most, for the parent to stop naming the folder, and say so in words if it still does (`CUBE accepted the removal of … but still lists it after 15s`).

  The listing cache also no longer keeps a listing that a change overtook while it was being read. A read takes a stamp before it asks CUBE (`stamp_take()`), and `cache_set(path, data, { since })` does not keep a listing whose folder, a tree above it, or the whole cache was invalidated after that stamp. brasa's VFS takes the stamp for an `ls` and for the refresh behind a stale one.

- Updated dependencies [eba14cc]
  - @fnndsc/cumin@3.29.1

## 4.4.0

### Minor Changes

- 02c20bf: Every function name now says what it does: the 462 that put a preposition where the verb goes are renamed (#1227).

  The style guide names a function `<subject>[Qualifier]_<verb>[Adverb]`. Names such as `answerRows_of`, `seriesUID_ofPath`, `options_toParams` and `ask_onPane` put a preposition in the verb's place, which names the result without saying whether the function derives, parses, builds or renders it. They are now `answerRows_derive`, `seriesUID_parse`, `options_convertToParams` and `askOnPane_await`. A preposition may still qualify the verb (`x_readFromCache`) or the object (`askOnPane_await`); it may not start the method.

  `npm run lint:rpn` (`scripts/rpn-prepositions.mjs`) refuses a function, `const` function or underscored method whose method is, or starts with, `of`, `to`, `with`, `from`, `for`, `by`, `as`, `in`, `on` or `at`, and CI runs it. The exported names change with no aliases kept: nothing outside this repository imports them.

### Patch Changes

- Updated dependencies [02c20bf]
  - @fnndsc/cumin@3.29.0
  - @fnndsc/fond@0.6.0

## 4.3.0

### Minor Changes

- e1d052d: ARGUS shows the kernel's cohort instead of keeping its own copy. Its GATHER, REMOVE, CLEAR, name and CREATE FEED presses send `gather add|remove|clear|name|feed`, and the band and the GATHER pane redraw from the `gather.cohort` model those verbs answer with, including a line typed at any chell on the session. ARGUS no longer writes `~/gather/current.json`.

  The kernel now fills in what the surface used to supply. `gather add` on a PACS path takes the series' description, modality, file count, patient and study from the query answer the path names (from the PACS mount's cache, so at most one CUBE read per query). A gathered folder is imagery when its name or place says it is a series, by the rule ARGUS's viewer uses, which now lives in `@fnndsc/menu` as `seriesFolder_is`. `gather feed [--title T]` makes the cohort's feed: series still at the PACS are pulled first, then one feed is rooted on every member, folders included. `gather name` answers with the cohort, and so does a `pull` that noted landed folders on it.

  `PacsVfsProvider.queryResult_fetch` is public, and `vfsDispatcher.pacs` names the PACS mount. `pacsQueryModel_build` moved to `builtins/net/query.model.ts` and is still exported from `query.ts`.

### Patch Changes

- a0fa450: A pipeline run with no `--compute` runs each node on a compute its plugin is registered on, not always `host`. It keeps `host` where the plugin has it, else takes the plugin's first. On a CUBE whose computes are named otherwise (ekanite's `argentum`), every `pipeline run` and `gather process` of a pipeline was refused until `--compute` was given (#1226).
- 46bc80d: Zod moves to 4.6.7: zod 3 carries a high-severity advisory with no 3.x fix, which failed every build's audit. The advisory is GHSA-mrhx-c7xc-m3w5, memory exhaustion while validating oversized constrained collections. The wire schemas read as before: `.catch` fallbacks, `.default` values, `.passthrough()` and the recursive DICOM tag parse were checked against zod 4. `dicomTagSchema` is typed `z.ZodType<DicomTag, unknown>`; schemas exported from `@fnndsc/menu` are zod 4 schemas, so code that names zod 3's types against them (`ZodTypeDef`, `SafeParseReturnType`) has to move too. A boundary reason now renders a symbol in a path instead of throwing. salsa's nested lockfile, which only the audit reads, overrides zod until a `@fnndsc/menu` built on zod 4 is published, and is back in step with salsa's `package.json`.
  - @fnndsc/cumin@3.28.6

## 4.2.1

### Patch Changes

- Updated dependencies [1e637f1]
  - @fnndsc/fond@0.5.0
  - @fnndsc/cumin@3.28.3

## 4.2.0

### Minor Changes

- 20cd854: The job index keeps which pipeline run made each job, and find asks it with -pipeline and -workflow, CUBE never asked.

  Each `/proc/jobs` job keeps its CUBE row's `pipeline_name` and `workflow_id` (a job run directly keeps null), saved in the checkpoint. Jobs restored from an older checkpoint are read again once, feed by feed on six lanes, behind the prompt. `find /proc/jobs -pipeline 'FreeSurfer*'`, `-pipeline ''` (a direct run) and `-workflow ID` answer from the index; a job whose run is not known yet is not judged, and `find` names how many on stderr instead of dropping them silently.

### Patch Changes

- Updated dependencies [20cd854]
  - @fnndsc/cumin@3.28.0

## 4.1.0

### Minor Changes

- e9d9540: Questions about runs are now answered from the session's job index with find over /proc/jobs, asking CUBE nothing. -plugin and -status test what a job ran and how it ended, so find /proc/jobs -plugin pl-dylld -status finishedWithError lists every failed run. A mount can answer a whole subtree for find; /proc/jobs does.

### Patch Changes

- Updated dependencies [e9d9540]
  - @fnndsc/fond@0.4.0
  - @fnndsc/cumin@3.27.20

## 4.0.6

### Patch Changes

- c7acb1b: A new find command walks the namespace through the listing cache and prints the paths its expression selects. Tests are -name, -iname, -path, -type and -newermt, bounded by -maxdepth and -mindepth, printed with -print or -print0, and joined by -o, ! and parentheses; a tree already seen is walked without asking CUBE. An unforced /proc/jobs roster check runs at most once a minute, and REFRESH still forces one.
  - @fnndsc/cumin@3.27.19

## 4.0.5

### Patch Changes

- b1bffe1: A warm `ls`, `cd` or `cat` asks CUBE nothing. Whether a path is a folder comes from the memoised folder lookup, not a fresh listing of its parent; a lookup that found nothing is kept as long as a listing; /etc's compute.yaml and passwd and the /usr/share plugin records are kept. /proc/workflows, which walked every workflow on the CUBE, is unmounted (docs/proc.adoc).
- Updated dependencies [b1bffe1]
  - @fnndsc/cumin@3.27.18

## 4.0.4

### Patch Changes

- d26f22c: Listing /proc/jobs and entering a feed no longer wait on CUBE: the roster check runs behind the answer after 250 ms. A session booted from a door's token keeps its folder lookups memoised, as a password boot always did; a lookup that finds no folder (a shared feed's own path) is kept 15 seconds instead of asked again by every caller; `ls` reads a listing once; a parent's fresh listing answers whether a child is a folder; the PACS server list is kept a minute. The terminal console's text is the transcript's size again.
- Updated dependencies [d26f22c]
  - @fnndsc/cumin@3.27.16

## 4.0.3

### Patch Changes

- 90b7688: REFRESH on the feed roster now walks the whole index even when pressed during a quick check for new feeds. Before, the press was absorbed into that check: it saw nothing new and its bar never said CHECKING CUBE FOR THE FEED LIST.
  - @fnndsc/cumin@3.27.15

## 4.0.2

### Patch Changes

- 9065319: A feed shared with you is marked NEW until you open it, across logins (#1065). RUNS leads with a NEW SINCE YOUR LAST VISIT block, each row marked with who shared it, and the bar counts them. Opening a feed takes its mark off, and CLEAR NEW takes them all. `proc feeds --new` lists them and `proc seen` clears them. Your own feeds and public feeds are never marked.
- Updated dependencies [9065319]
  - @fnndsc/cumin@3.27.13

## 4.0.1

### Patch Changes

- e29bf91: A feed shared to you is seen on your next look at the roster, not after the next ten-minute walk (#1058). The roster's delta reads each collection's newest page and walks whole when the total moved, so a share, an unshare or a deletion lands on the visit that follows it. `proc feeds <q>` matches a feed's title, its `feed_N` name and its id; a bare id the roster lacks is asked of CUBE live and adopted, or refused with why (not shared with you, or shared to a group you are not in). `ls /proc/jobs/feed_N` asks the same way. In ARGUS a RUNS filter that names a feed by id and matches nothing asks the session too: the row arrives marked, or the field says what CUBE answered. The roster frame gains REFRESH (`proc feeds --fresh`), and the bar says `CHECKING CUBE FOR THE FEED LIST…` while any walk runs and `FEED LIST CURRENT · n NEW` when it lands.
- a0f0160: Jump to a feed or a node by its number (#1061). `proc jump 639204` goes to the node, `proc jump feed_4389` to the feed, asking CUBE for anything shared since the roster was walked. A bare number that is both a feed and a node is never guessed: chell names both, and RUNS asks which. RUNS gains JUMP TO on the roster frame: it asks for the number, enters the feed, and selects the node once the graph is drawn, without moving the console's working directory.
- 1b93202: A large file downloads, and a file in a feed shared with you downloads (#1061). A file stream has no 30 s deadline any more: CUBE held a 3.7 GB DICOM's first byte for up to a minute, and the old deadline killed every attempt. A watchdog fails a transfer only after two silent minutes, and says so. A file in a colleague's shared feed is read through CUBE's file browser, which serves it where `/userfiles/` answers 403. `download` names the kernel's reason (a stall, a refusal, a file too large to read whole) instead of "Failed to download file", and a file over 256 MB is never read whole into memory after a failed stream. ARGUS's DOWNLOAD streams through the daemon with its length in the header, so the browser draws its own progress and the daemon holds nothing whole.
- Updated dependencies [e29bf91]
- Updated dependencies [1b93202]
  - @fnndsc/cumin@3.27.12

## 4.0.0

### Major Changes

- 1681476: A failed copy says why without the stack's internal markers (no more `cp: [StaticVfsProvider.cp …] | cp: …`). Underneath, every filesystem operation answers with a reason (#1001). fond adds the filesystem contract: `VfsErrno`, `VfsOutcome` and `vfsRefusal_text`, which keeps the shell's existing wording for each refusal. Mount operations (read, readBinary, write, mkdir, rmdir, rename, cp, and the new rm and rmTree) return an outcome instead of a boolean or `Result`. The dispatcher asks the fallback too, through its path resolver. fond also adds `MemoryVfsProvider`, a complete in-memory mount, and `VFS_CONTRACT`, the cases any mount must pass. salsa's mounts and dispatcher return outcomes, so its callers change (a major bump). A mount's own message travels as the reason, so every refusal reads as before. proc's unreachable `rm` becomes `feedJobs_cancel`.

### Minor Changes

- f6171f7: Nothing changes at the prompt: salsa's CUBE mount answers every filesystem operation, held to fond's contract (#1001). It now offers read, readBinary, write (which replaces), mkdir, rmdir, rename, rm and rmTree, each failing with the errno a disk would give. CUBE's own words carry over as the reason: its "File not found", and its refusal to overwrite on rename. A test runs fond's `VFS_CONTRACT` against the mount with CUBE faked in memory. The core's file tools move onto these operations next.

### Patch Changes

- 11853c6: Reading a folder as a file says `Is a directory`, on every mount (#1026). A home folder had answered with CUBE's words for a missing file, `/proc` and `~` with "No files found in directory", `/bin` with "Unknown /bin entry", and `/proc/jobs` with nothing at all and exit 0. The dispatcher now answers EISDIR for any failed read of a path its parent lists as a folder. /proc reads no folder or unknown name as empty text. The native mount keeps CUBE's words only for a path that is missing. cat names the path once.
- 423971a: Making folders with parents never puts one over a file or beneath one, and missing parents no longer fail the command. `mkdir -p a/b/c` had made the folders and still exited 1, because looking up a parent that was not there left its complaint on the error stack. `mkdir` now goes through the backend's filesystem. fond's mounts gain `mkdirTree` (a folder and its parents in one step, as CUBE makes them), and the contract holds it: EEXIST for anything already there, ENOTDIR beneath a file. A mount without `mkdirTree` is walked one parent at a time. Under `-p`, something already there counts as done only when it is a folder; a file is `File exists`. salsa's `folderPath_holder` names the nearest thing holding a path or a parent of it. The fs views (`mkdir_render` and its kin) live in fond.
- 77a914f: A refused removal names what the path is, where it had said `No such file or directory`. `rmdir` of a file says `Not a directory`, `rm /proc/jobs` says `Read-only file system`, and `rm /bin` says `virtual /bin directory`. `rm` and `rmdir` go through the backend's filesystem (#1001). rm removes a file or link with the mount's `rm`, and a folder only with `-r`: with `rmTree` where the mount offers it, else entry by entry, deepest first. Nothing there is fine under `-f`. A projection's path is its mount's to remove or refuse. The /proc/tags hints (setfattr untags a feed, rmdir deletes a tag) and the /bin refusal move into those mounts, so the core names neither. rmdir asks the mount's `rmdir`. The ChRIS-only folder probe (`folderExists.ts`) goes.
- 3175b3d: Writing into a missing folder says `No such file or directory`, as on a disk, rather than making the folders. `touch` and `mv` go through the backend's filesystem (#1001). touch writes with the mount's `write`. A file already there is kept as it is when no content is given, and a projected file takes text only. ARGUS makes `~/gather` before it writes the cohort there, and waits for it. mv moves into a folder the destination names, keeping the source's name. It says a missing source by name and passes the mount's refusal on once (CUBE cannot overwrite). The shared helpers (`entry_at`, `folderTree_make`) live in `builtins/fs/entries.ts`. The native mount drains what looking up a missing parent said, as `pathHolders_find` does.
- fb31bef: A folder and a file never share one path. CUBE lets them, and removing the folder then damages the file's record so every listing of the parent fails (CUBE #732). `mkdir` over a file answers `mkdir: cannot create directory 'X': File exists`, and beneath a file `Not a directory`. `touch` or a write over a folder answers `Is a directory`. `mv` onto anything that already holds the destination refuses (`Destination exists`). `cp -r` skips a file whose name a folder holds, with a warning. `rm` refuses a path that a folder and a file already share, removing neither. salsa's `pathHolders_find` names what holds a path.
- Updated dependencies [11853c6]
- Updated dependencies [ebd7b3e]
- Updated dependencies [423971a]
- Updated dependencies [a12c6fc]
- Updated dependencies [e1215ef]
- Updated dependencies [1681476]
  - @fnndsc/fond@0.3.0
  - @fnndsc/cumin@3.27.11

## 3.21.2

### Patch Changes

- e1deb53: Nothing changes for chell, ARGUS or porter users: the virtual filesystem's contracts and dispatcher now live in fond. fond's dispatcher knows no backend; salsa's CubeVfsDispatcher registers CUBE's mounts on it in the same order, so every path routes as before.
- Updated dependencies [e1deb53]
- Updated dependencies [5bb17f6]
  - @fnndsc/fond@0.2.0
  - @fnndsc/cumin@3.27.9

## 3.21.1

### Patch Changes

- 73c0087: A PACS series that arrives is no longer shown as ERROR. The retrieve watch always asks CUBE before it gives up on a series (with no retries, the default, it never did), a series not seen to finish and not yet in CUBE is UNCONFIRMED with its reason rather than ERROR, and the watch waits a minute (not fifteen seconds) for a PACS slow to begin. Progress messages carry an optional `reason`, shown on the ARGUS badge and in pull's summary. In ARGUS a fresh answer finding a series home in CUBE replaces a pull that ended badly, and a pull waiting on its first file paces again instead of drawing a still empty bar. After twenty seconds of silence a pull checks CUBE and then asks whether to keep waiting (a surface that cannot be asked waits a minute). ARGUS runs the PACS pane's pull and query as the operator's own acts rather than instrument traffic, so they can ask.
  - @fnndsc/cumin@3.27.4

## 3.21.0

### Minor Changes

- 1c8b92d: A feed's name and sharing, whole, in the kernel (#853, slice 1). `/proc/jobs/feed_N/title` is writable: its first line renames the feed (`touch --withContents=`, `edit`), and the roster says so at once. `setfacl` speaks every entry CUBE has: `-m u:<user>:r`, `-m g:<group>:r`, `-m o::r` (public) and `-m o::-` (private again); `-x u:<user>` and `-x g:<group>` withdraw a grant (a feed that held none is said). `chmod o+r` / `o-r` is the other entry spelled as a mode. `getfacl` shows users, groups and `other::`. A feed is also named by `/proc/jobs/feed_N`. `feeds share` is retired and refuses by name; SHARE's question no longer says a grant is permanent; the access and tag verbs get a help category. cumin gains `feedAccess_read`, `feedShare_group`, `feedShare_revoke` and `feed_rename`.
- e20fb09: A feed's note is a file (#831, slice 1b): `/proc/jobs/feed_N/note` lists beside `status` and `title`, `cat` reads it and `touch --withContents` writes it whole (its title stands), and `edit /proc/jobs/feed_N/note` opens it in the surface's editor and saves it back through the projection — a projected file is never uploaded into CUBE's store. `feed note edit` now edits through the surface's editor seam (`localEdit`) instead of spawning `$EDITOR` itself, so a browser surface can offer its own editor; a surface without one refuses by name. Fixed on the way: an empty `# Title:` line no longer takes the note's first line as its title.
- 59399fe: Tags are a vocabulary of folders under `/proc/tags` (#831, slice 4a). `ls /proc/tags` lists your tags (an unworn one too); `ls /proc/tags/<tag>` lists the feeds wearing it as links to `/proc/jobs/feed_N`, and `cd` through one lands in the feed. `mkdir /proc/tags/<name>` makes a tag, `rmdir` deletes one no feed wears ("Directory not empty" otherwise), and `mv` renames one. `setfattr -n tag -v <name>` no longer makes a tag: naming one that does not exist is an error naming the cure (`mkdir /proc/tags/<name>`). `rm` under `/proc/tags` is refused and names the verb that does the job. New builtin `rmdir` (empty folders only, as on Linux, on the store and in projections); `mkdir` and `mv` route a projection's paths to it, and a projection that makes or renames nothing refuses by name ("Read-only file system", "Invalid cross-device link"). The old read-only `/tags` projection is retired. cumin gains `tags_index`, `tag_create`, `tag_delete`, `tag_rename` over one cached index of the user's tags and their feeds.

### Patch Changes

- Updated dependencies [1c8b92d]
- Updated dependencies [ddbd551]
- Updated dependencies [32e3919]
- Updated dependencies [59399fe]
  - @fnndsc/cumin@3.27.0

## 3.20.1

### Patch Changes

- c371b47: A feed the roster gains after the topology sweep lands its jobs on its own: every roster sync (the watcher's delta, the full walk, a restored roster brought into service) queues the feeds it leaves without topology, and one detached walk at a time lands them behind the prompt — so a feed created after the sweep, or restored from a roster whose shard was never written, shows SIZE and TIME in the RUNS listing without anyone opening it. `proc stat` names the feeds still landing.
- Updated dependencies [fbb1579]
- Updated dependencies [576b948]
- Updated dependencies [4864a34]
- Updated dependencies [7fb4c21]
  - @fnndsc/cumin@3.26.0

## 3.20.0

### Minor Changes

- fbd3f0a: Data facts reader v2: a series in CUBE's PACS store is described by CUBE's own series record (asked once per patient) before any header is read, and each feed records `sourceFeed` when its data lies in another feed's output. Under DATA that lineage is drawn as a faint thread from the source feed's root (`joinFaint`: a thread, never a tube).

### Patch Changes

- Updated dependencies [fbd3f0a]
  - @fnndsc/cumin@3.25.0

## 3.19.0

### Minor Changes

- f571a14: The /proc index reads what each feed's data is, once: from the first file its root job made (by name, descending into a folder), the format, and for DICOM the modality and series description from one header read. It runs after the topology sweep, as each feed's topology loads, and after a checkpoint restore; what cannot be known yet is tried again, what is known to be absent is recorded with its reason.

### Patch Changes

- 8602c78: Reading a feed's data costs its first page, not its whole folder: the reader lists the first fifty folders, files and links of a level, reads a DICOM header from the first 2 MB of a file (the parse stopping at the pixel data), passes over XML reports, tries a few UID-named files as DICOM, and says when a feed's data lives somewhere this identity may not read.
- a8d0d99: The data-facts sweep reads in rounds: what a round cannot answer yet (a header that failed once, a read that ran out of time) is tried again after a pause, until a round records nothing and every header has had its tries. A single round had left 199 of 709 feeds unread for as long as the daemon lived.
- d1da8ac: `proc universe` carries what each feed's data is (`data`: format, and for DICOM modality and series description) once the index has read it. The reader follows a copy job's links (to files and to folders), reads newest feeds first, four at a time, gives a feed that never answers 45 s before moving on, records a DICOM-named file whose header will not read as DICOM with the reason, and stamps each record with its reader's version so a better reader reads feeds again.
- Updated dependencies [e7f82dd]
- Updated dependencies [0f9ae74]
  - @fnndsc/cumin@3.24.0

## 3.18.2

### Patch Changes

- e74ce1d: salsa: a new feed's output path belongs to the feed's owner, not the input's.

  Rooting a feed on data somebody else owns — a PACS retrieve lives under `/SERVICES/PACS/<server>/…` — predicted an output path of `/home/PACS/feeds/feed_N/…`, because the owner was read off the third segment of the INPUT path. The feed itself sat in the caller's own home, so the predicted folder was one nobody could list, and anything that followed the prediction looked at nothing.

  The owner now comes from the created feed, falling back to the old reading only when CUBE does not say. Found by a manifest that anonymized a PACS series and then asked what it had produced.

- 3320487: salsa: a touch carrying content REWRITES the file it finds.

  CUBE's upload does not replace. Uploading over a path that already held a file left the OLD content in place and still reported success, so anything written to the same path twice kept its first version forever — the surface's own cohort file was written on every change and had not changed since the first one. Content given for a path that already exists is a rewrite: the file there is removed first, and a removal that fails is reported instead of written over.

  chili's readout was the second half of the same lie. A touch that carried content now says it WROTE the file rather than created it, so replacing an operator's file never reads as making a new one.

- a010cb0: salsa: an absent annotations folder is an answer, not a fault.

  Summarizing a series looks for annotations under the series UID. Most series have none and the folder does not exist, which the summary already handled — but the failed listing was left on the error stack, and the dispatch boundary reads a command that leaves errors behind as a command that failed. So `dcm series` printed a complete, correct readout and exited non-zero.

  Found by playing a manifest: a workflow that reads a header stopped dead on a line that had just worked. The lookup now drains the miss it went looking for.

- Updated dependencies [7bba167]
- Updated dependencies [43b9440]
  - @fnndsc/cumin@3.23.0

## 3.18.1

### Patch Changes

- a4a38b1: A file under a `/proc` projection can be read. The proc provider resolved a node's `data` to the CFS file behind it and then handed that file back to the dispatcher, whose default provider is the host filesystem — which refused it; it now reads the target through `fileContent_get`, the door that knows both worlds. The engine's `file_read` (the daemon's `/vfs` route) resolves the path it is given, so a surface can read a file at the address the session uses for it.

## 3.18.0

### Minor Changes

- 9cf2ea2: `image <path>`'s text reflection now carries a thumbnail of the middle slice, so a TTY sharing the session shows the picture, not only the facts. The kernel reads the slice's pixels (`dicomSlice_gray` in salsa, uncompressed transfer syntaxes via dcmjs), window/levels to 8-bit with MONOCHROME1 inverted, and box-downsamples to a cell grid; brasa renders it as an ASCII ramp on any pipe or ANSI truecolour half-blocks (`▀`) on a colour terminal. Colour is a new declared surface capability: ARGUS declares it (its DOM console renders ANSI), chell reads its own terminal through chalk, a bare pipe gets the ramp. Compressed pixels say so in one line rather than pulling a codec into the kernel; an unreadable slice leaves the facts and no picture. The ASCII ramp is always the floor.

### Patch Changes

- @fnndsc/cumin@3.22.1

## 3.17.0

### Minor Changes

- 163e4b1: `pacs query --anon` stands in for what an answer says about a person, for demonstrating against a live hospital PACS. Record numbers and accessions become salted tokens, a name becomes a stand-in name of the same DICOM shape, a study date falls back to the first of its month and a birth date to its year. The substitution happens on the decoded payload, so the model a surface renders, the console table and any CSV all say the same thing. The salt is made once per daemon and never written down, which makes tokens stable through one demo and meaningless after it: an unsalted digest of a seven-digit record number is a second's work to reverse. DICOM identifiers are left alone, since they are never shown and are what the held-state reconciliation matches on.

### Patch Changes

- Updated dependencies [aa923c6]
  - @fnndsc/cumin@3.22.0

## 3.16.0

### Minor Changes

- af2df66: DICOM in the kernel: `dicomTags_read` parses a file's elements with dcmjs (dictionary names, VR, module group, PHI flag, decoded words, nested sequences), `dicomTags_summarize` tells constant from varying across a folder, and `dicomSeries_summarize` answers what a folder is as a series from its listing plus one header read (identity, modality, instance count, stack order from oxidicom's file names, geometry, transfer syntax, bytes, annotations by SeriesInstanceUID). Headers read once are cached by path.

### Patch Changes

- b9ec3aa: A retrieve watch measures quiet across the whole study, not per series. A PACS serves a study's series in turn, so every series still queued fifteen seconds after firing had no files and was declared unconfirmed: pulling a whole study reported every series after the first few as lost while pulling one series alone always worked. Silence is now evidence only when nothing has arrived for any series, the long stop counts from a series' first file rather than from the fire, and a reconnection no longer reads as silence.
  - @fnndsc/cumin@3.21.1

## 3.15.0

### Minor Changes

- 612c052: A path walk over a projection path (`/proc`, `/net/pacs`, `/etc`, `/usr/share`) no longer litters the console with a cumin context-init failure for every ancestor. `files_getGroup` asked the raw CUBE-files layer to build a folder context for each segment while resolving links — `cd` into a `/proc` job did it once per ancestor — and a projection has no CUBE folder, so each attempt failed three lines at a time. The dispatcher now answers `path_isVirtual`, and `files_getGroup` returns "no such group" for a projection path without troubling cumin, since the projection's own provider is what lists it.

### Patch Changes

- Updated dependencies [711e1b3]
  - @fnndsc/cumin@3.21.0

## 3.14.0

### Minor Changes

- 6cd5ab1: feat(salsa): index movement never holds the lane — `feedInstances_ensureStarted` starts a cold feed's topology walk and returns `pending`, the walk runs detached and deduped, a failure is named in the load register, and `feedGraphData_ensure` reports readiness instead of waiting
- 57ba039: fix(salsa): `proc refresh <feed>` keeps the feed's roster row and evicts only its topology — a feed seen through the public listing is not in the own-feeds endpoint, and a refresh that removed the row and could not re-read it left the feed "not found" after its re-walk; the row is re-read from the own feeds, then the public ones
- adf8cc1: feat(salsa): a feed's topology walk fetches four pages at once (`FEED_WALK_IN_FLIGHT`), so a 58,760-node feed that walked for 28 minutes sequentially on a 2.8 s/page CUBE lands in about a quarter of that; the global sweep keeps its sequential, resumable loop
- 98ab832: feat(salsa): `procRoster_syncStart` starts the roster sync and returns at once, deduped with a sync in flight and named in the cache while it runs; `procRoster_sync` still waits for callers that must

### Patch Changes

- Updated dependencies [6cd5ab1]
- Updated dependencies [57ba039]
- Updated dependencies [adf8cc1]
- Updated dependencies [98ab832]
  - @fnndsc/cumin@3.19.0

## 3.13.0

### Minor Changes

- f5c16fe: fix: a listing says what it could not read, and cat reports instead of crashing

  **A listing that could not read part of itself says so.** `ls` asks a folder for its directories, its files and its links, and a refused sub-listing was being dropped for looking like an empty one — so the home root whose file listing CUBE refuses rendered its folders alone, as though that were everything. The provider now names what it could not read (`Cannot fully list <path>: could not read files (Internal server error)`) and the listing carries that reason with the entries it did get.

  **`files_listAll`'s `null` meant three things** — an empty folder, a folder that is not there, and a folder the server would not describe — and nothing above it could behave correctly on one word that means all three. `files_listOutcome` says which: `listing`, `empty`, `missing`, `refused`. `files_listAll` stays as the lossy wrapper, but a refusal now throws rather than passing for absence.

  **A file is deleted by its id**, not by finding it in a listing first. The folder whose listing the server refuses is exactly the one an operator needs to clear, and a delete that walks the parent cannot help there. `chrisIO.file_deleteById` is the new door; other asset kinds still resolve through the group.

  **`cat` reports an unreadable path instead of ending the session.** A read that threw — a path that cannot be resolved, a server that refuses — escaped as an unhandled rejection that dumped an axios request object, auth header included, and killed the process. Each path is now resolved and read inside its own guard: the failure is reported like any other unreadable file, the rest of the line still runs, and nothing is dumped.

### Patch Changes

- ec3ef9f: fix: a listing shows what is there — no silent page limits

  `ls /net/pacs/queries` answered with 100 of 1,817 stored queries and said nothing about the other 1,717. That was one symptom of a pattern: callers reaching a single-page list call with a literal limit and returning the page as though it were the collection.

  **The default is now the collection.** A caller that names no limit gets a walk to exhaustion, not the first twenty. A caller that names one gets exactly that page, marked `incomplete` with what it is showing of what exists — a bound the surface can state rather than a truncation nobody sees.

  **A walk that stops says where.** CUBE fails some collection queries past an offset (measured: `userfiles` answers to offset 800 and returns 500 at 1000). The walk keeps what it gathered and reports where it stopped, rather than handing back a prefix that reads as an ending. A walk whose _first_ page fails is still a failure, since a listing that never started is not a short listing.

  **Three callers fixed:**

  - `pacs status` searched the first 200 queries for a matching expression, so anything older answered "not found". It walks now — verified live against a log of 1,897, finding query 3.
  - `getfacl` read a feed's first 100 grants. A hundredth name is not a natural place for that answer to stop.
  - A `ts` node's join edges are read from its parameters, which were fetched one page deep. A node with more parameters than a page silently lost its edges — a graph drawn short.

  **And a gate**, `npm run lint:listings`, in CI: a literal `limit` above one reaching a single-page list call fails the build unless the line says `listing-bound:` and why. Two bounds are declared today; both are exact-path lookups, not collections.

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
- Updated dependencies [ec3ef9f]
- Updated dependencies [5a339f0]
- Updated dependencies [17964a9]
  - @fnndsc/cumin@3.18.0

## 3.12.1

### Patch Changes

- aa25502: The process cache records the compute resource each plugin instance ran on (from the CUBE list row), and the `feed.dag` model carries it per node (`mixed` for a group whose members ran on different resources), so a surface can hue a graph by where its work ran.
- f8d1b1c: Index movement is annunciated: a feed's first-visit topology load (`feed 812 indexing: 3400/20000 17%`) and roster arrivals (`+feed 812`, feeds created since or newly shared) reach the prompt context's `procWarmup` segment — `feed`, `arrived`, and `sweeping` so a renderer can tell a sweep from a load — and the chell prompt renders both. The process cache keeps the two registers (`feedLoad_progress/clear/get`, `arrivals_note/recent`); the salsa feed walk and roster syncs feed them.
- aaf0159: `/proc` synthesized files (a node's `log`, `params`, `status`) now serve their UTF-8 bytes through the binary read path, so byte readers such as the daemon's `/vfs` route see the same content `cat` does.
- 85c6813: The session-state context (working directory, feed, plugin, PACS server) is owned by the process once loaded: its files are written for the next process to restore from, never re-read mid-session. Two daemons of one identity shared a working directory through `cwd.txt`, and a `cd` in one moved the other. Identity (user, URL) still reads from storage; a connect reloads everything.
- Updated dependencies [f73e6c2]
- Updated dependencies [3afaa65]
- Updated dependencies [5b4b7db]
- Updated dependencies [eaf6c67]
- Updated dependencies [aa25502]
- Updated dependencies [f8d1b1c]
- Updated dependencies [85c6813]
  - @fnndsc/cumin@3.17.0

## 3.12.0

### Minor Changes

- 25c4ebc: Faster daemon entry. A restored `/proc` roster now goes into service on a delta (feeds newer than the highest restored id) instead of a full feed-index walk; the full walk runs behind the listening daemon and reports how many feeds moved while it was away, each refreshing on its next visit (`procRoster_bootSync`; `procRoster_sync` now returns the feeds it brought in or found changed). The rendered `/etc/group` projection lives in the listing cache, so it survives a restart with the listings: past its freshness window it serves at once and re-renders behind itself, and a local membership change still forces a synchronous re-render. The listing checkpoint accepts any JSON payload, not only listings.

### Patch Changes

- Updated dependencies [25c4ebc]
  - @fnndsc/cumin@3.16.1

## 3.11.0

### Minor Changes

- cece0dc: `/proc` freshness is now visit-driven. A revisit to `/proc/jobs/feed_N` (or a `feed diagram` re-render) is a delta, not a re-crawl: one feed-row fetch, and only when the job counters moved, a `min_end_date` walk of the nodes created or finished since the last visit plus an `active=true` sweep of the nodes still running. Nodes a dynamic pipeline spawns after the first load now appear on the next visit; previously they were invisible until `proc refresh`. Settled feeds are re-checked at most once per ten minutes, so work appended to a finished feed is still seen. A `/proc/jobs` visit (and `proc feeds` / `proc jobs list`) picks up feeds newer than the highest known id, and walks the whole index once the roster is older than ten minutes, so a feed shared later still appears.

### Patch Changes

- 920e0ac: Checkpoint integrity: a snapshot whose topology-loaded feeds are missing from its roster is refused (never overwrite a good checkpoint with an amputated one), and an empty public-feeds walk while public feeds are already known is treated as a failed source — the known feeds are kept and a warning raised — instead of authoritative absence that removed every public feed from the roster.
- 97af423: Watches: a surface can keep a running feed live. New wire pair `watch` / `unwatch` (subject = `/proc/jobs/feed_N`, owned per surface, released on detach) and a `watched` report (`live` | `settled` | `stale`). While anyone watches a feed the engine samples it on an adaptive cadence (3 s while it changes, backing off to 30 s when quiet), and whenever a visit changes the cache it publishes the refreshed `feed.dag` model to every surface as a session-bus envelope from the `daemon` surface, off the scrollback. A feed that settles reports `settled` and the watch ends; a failed sample reports `stale` and keeps trying. `proc watch <feed>` / `proc unwatch <feed>` are the console forms (`proc watch` lists). The engine gains an ambient event bus for events it originates on its own. Feed visits within one second of each other now share one sync, and `feedVisit_sync` reports whether it succeeded.
- Updated dependencies [920e0ac]
- Updated dependencies [7a0f06e]
- Updated dependencies [c716624]
- Updated dependencies [cece0dc]
  - @fnndsc/cumin@3.16.0

## 3.10.1

### Patch Changes

- 1bc0953: `ls` on a ChRIS link (`~/public`, `~/shared`) follows the link instead of rendering the link entry itself: the parent-cache leaf shortcut no longer captures links, so resolution falls through to the dispatcher's PathMapper. Native listings are also name-deduplicated (CUBE's links search can return the same row twice, observed on /PUBLIC).
- Updated dependencies [44ba77a]
  - @fnndsc/cumin@3.15.1

## 3.10.0

### Minor Changes

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

- 2bb9c29: Registered pipelines gain a durable package store: a warm-up tail sweeps the registry after the topology index settles, fetching only never-seen pipelines and checkpointing identity plus registered manifest to a local CUBE-keyed file. The `/usr/share/packages/<pipeline>` tree serves each pipeline's fields and canonical `manifest.yaml` from that store, and `pipeline diagram` answers from it with no wire traffic at all. The same settlement tail also resolves every unresolved topological-join edge in the background, so a feed's first diagram — however large — renders from cache.
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

- 2c38d8b: Three relations CUBE owns that the namespace could not reach are now projected.

  **`/proc/workflows`** — instantiated pipelines, beside the jobs they own. A
  workflow names the pipeline it ran and owns the plugin instances the run
  created, which is runtime state, so it sits with `/proc/jobs` rather than with
  the pipeline definitions in `/bin`. It projects as a directory of links: the
  `pipeline` entry into `/bin`, each entry under `jobs/` into `/proc/jobs`.
  Nothing restates a job's own representation. Links are lazy — a listing names a
  link without paying to resolve it.

  **`/tags`** — the tags themselves. A tag is a first-class user-owned resource
  pointing at many feeds, so projecting it inside a feed would flatten a
  many-to-many and make editing ambiguous about which copy changed. One object,
  one path.

  **`/usr/share/<plugin>`** — a plugin's version-independent identity: authors,
  licence, type, repository. `/bin` stays flat; nesting versions under a plugin
  directory would make an executable a directory, which is the application-bundle
  trick and costs a permanently divided view. The Unix answer was already here —
  `/bin` holds executables and `/usr/bin` holds their help text — so metadata
  extends that parallel tree. A name given with a `/bin` version suffix resolves
  to the version-independent record.

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

### Patch Changes

- a78b5ee: Everything under a job's `data` link now belongs to the link's target.

  `ls /proc/jobs/feed_N/<plugin>_<id>/data` silently re-listed the instance
  directory (status, params, log, data) instead of the job's output space, so
  a browser rooted at the link showed the wrong entries and built nonsense
  paths like `.../data/log` from them. The proc provider now recognizes the
  `data` segment anywhere after an instance and delegates the whole subtree —
  listing, text reads, and binary reads (new `readBinary`, so images in an
  output space render) — to the resolved CFS target path.

- 56ade16: Pipeline diagrams are cached per client keyed by pipeline id (registered pipelines are immutable, so the first build is the only CUBE traffic a diagram ever costs a session), and a fully settled feed's diagram now renders from the process cache with no status refresh at all — the refresh runs only while some instance can still change.
- Updated dependencies [1c195a7]
- Updated dependencies [e58bf58]
  - @fnndsc/cumin@3.15.0

## 3.9.0

### Minor Changes

- 386b28c: Walker edge hardening from post-merge review. `ListPage` gains `fetchedCount` so a page whose malformed rows were dropped client-side still advances the walk by what the server served, closing a refetch/early-termination gap in `listPageFlexible_wrap`-backed drains; `pluginPipingsPage_get` exposes the piping list with its pagination signals and the manifest and diagram projections use it (the diagram's `limit: 1000` single-shot now drains fully). A shared `collectionPage_wrap` replaces five hand-copied collection-to-ListPage transcriptions. Salsa's pure PACS folder grammar moves to a dependency-free `pacsGrammar` module exposed as the `./pacs-grammar` subpath, so test mocks forward the real functions instead of maintaining copies.

### Patch Changes

- Updated dependencies [386b28c]
  - @fnndsc/cumin@3.14.0

## 3.8.1

### Patch Changes

- b20fa64: Pagination completion: `listPages_drain` joins `listPages_walk` for callers that need a whole collection, and `ListPage` gains an optional `hasMore` hint so a walk survives servers that cap the requested limit. Cumin's own remaining loops (groups, group members, current-user memberships) now ride the shared walker, the peer-store link follower gains a cycle guard and a reported page cap, and the single-shot `limit: 1000` reads in feed resolution, feed comments, workflow creation, and pipeline manifests now drain every page instead of silently truncating at a guess.
- Updated dependencies [b20fa64]
  - @fnndsc/cumin@3.13.0

## 3.8.0

### Minor Changes

- b0b478b: PACS payload and path-grammar consolidation. Cumin gains `dicomPayload`, the one home for DICOM query-payload interpretation (tag unwrapping including the DICOM-JSON `{Value: [...]}` form, study and series array location, UID lookups), replacing four diverged private copies. Salsa's `pacsHelpers` becomes the single authority for the PACS folder grammar, adding `folderUID_get`, `queryLabel_extractFromFolder`, and `queryFolderName_build`; the query path a surface builds now always matches the name the listing shows, including the title fallback the old builder lacked. Brasa's `pacsUtils` and `query` builtins consume the shared helpers; `pacs_tagValueExtract` remains as a compatibility alias.

### Patch Changes

- bb4e06a: One pagination loop for the wire contract: `listPages_walk` joins `ListPage` in cumin's chrisapi contract, owning offset advancement, total latching, and termination for every paginated CUBE read. The six hand-rolled loops in salsa (five in the /proc VFS provider, one in job search) now consume it, so page-walk edge cases have a single tested home.
- Updated dependencies [b0b478b]
- Updated dependencies [bb4e06a]
  - @fnndsc/cumin@3.12.0

## 3.7.0

### Minor Changes

- 14f8ee8: Deletion works from any context. `rm` no longer depends on the session's
  current directory or a prior listing: `files_delete` anchors at the target's
  parent folder and loads its collection itself, and chili's `rm` passes that
  parent explicitly. New path-addressed deletion API: cumin
  `folder_deleteByPath` and salsa `folderByPath_delete`, which return only
  once the CUBE confirms the folder no longer resolves. Context writes are
  ordered after session-filename resolution, fixing a fresh session's first
  `cd` intermittently losing its value.

### Patch Changes

- Updated dependencies [14f8ee8]
- Updated dependencies [69b0617]
  - @fnndsc/cumin@3.11.0

## 3.6.1

### Patch Changes

- 5285bd5: Cast burndown to the adapter floor. The wire contract gains the pipelines
  surface (`pipeline_get` with piping items and plugin metadata handles,
  `pipelineSourceFilesPage_get`); salsa's pipeline modules, feed joins, and
  brasa/chili call sites migrate onto typed accessors and honest converters.
  The repository's `as unknown as` count is now 2, both inside the licensed
  adapter seam, and the CI ratchet holds it there. chell progress bars also
  draw on the renderer's configured stream instead of assuming stdout.
- 919648f: Typed chrisapi wire contract over the jobs and PACS surfaces. cumin gains
  `feedsPage_get`, `publicFeedsPage_get`, `pluginInstancesPage_get`,
  `pluginInstance_get` (typed detail handle with parameters, status, logs,
  delete), and `downloadToken_create`, with the wire row shapes (`FeedData`,
  `PluginInstanceData`, `InstanceParameterData`, `DownloadToken`) declared once.
  salsa's proc provider, job operations, and retrieve watcher now call the
  contract instead of casting the opaque client per call site.
- Updated dependencies [5285bd5]
- Updated dependencies [919648f]
  - @fnndsc/cumin@3.10.0

## 3.6.0

### Minor Changes

- 590a943: Converge the two PACS retrieve watchers onto one engine. pull's battle-tested LONK machinery (bounded, retried firing; stall/timeout/no-activity detection; storage confirmation; refire loop) moves into salsa as the presentation-free `retrieve/watch` module; the `pull` builtin becomes a thin consumer rendering engine events onto its sink, and the PACS VFS provider's `cp` drops its 5-second polling watcher for the same engine, gaining firing retry, LONK push, and the idempotency skip. The convergence surfaced and fixed two latent defects that had made PACS `cp` unusable on real paths: the source parser assumed paths without the `/queries/` segment and rejected every real listing path, and the file downloader only consulted the userfiles collection, so PACS files under `/SERVICES` read as "not found"; it now falls back to the PACS files collection. Supporting dedup: cumin gains `retry_untilValue` (the one bounded-backoff loop) and `seriesStorage_resolve` gains bounded re-probing, replacing the per-package storage-resolver copies; the `_qid:` parser is now shared from salsa.

### Patch Changes

- 2e60785: Cache the `/etc/group` projection per CUBE connection for five minutes,
  invalidate it after ChELL membership changes, and show semantic inspection
  progress while an uncached projection is resolving.
- 66bc932: Add ChELL group membership commands and include current CUBE usernames in the
  live `/etc/group` projection.
- d0ac04f: Preserve failure causes and tighten cache contracts. Errors that were replaced by generic messages now carry their real cause: controller and handler creation failures name the underlying error instead of "no ChRIS context", `cat` shows the actual fetch failure, docker command failures surface stderr detail, context-set errors actually print, settings load/save failures are announced instead of silently using defaults or losing changes, unreadable berth and discovery files are named instead of reading as "no daemon", token-file read errors are distinguished from the logged-out state, and resource deletes report why they failed. Every remaining deliberate error absorption now carries a dated adjudication comment. Cache contracts: the PACS provider's decoded-query cache caches settled results only and is size-bounded; the object-context factory gains an eviction hook (`objContext_evict`) for deleted plugin or feed ids; `mv` and `cp` invalidate the whole affected listing subtree; and a new PACS query invalidates the cached `/net/pacs/queries` listing so it appears in the next `ls` immediately.
- 886f09c: Fix stale directory state in long-lived daemons. Folder object contexts are no longer cached in the cumin context factory: folder paths are not stable identities in CUBE (deleting and re-uploading a directory assigns a new folder id), so a group bound at first touch kept serving the dead folder for the life of the process, which in a calypso daemon meant a freshly uploaded directory listed as permanently empty and `ls -f` could not recover it. Plugin and feed contexts keep their stable-id cache. The listing cache gains `cache_invalidateTree`, and `rm` and directory uploads now invalidate the whole affected subtree, so a delete-and-re-upload cycle cannot serve still-fresh nested listings from the old tree. The salsa native provider also distinguishes a missing folder from an empty one: when every sub-listing comes back empty it probes the parent, and a nonexistent path reports "No such file or directory" instead of rendering as an empty directory.
- 50e9bb1: Make CUBE group membership commands name-first and batch-capable. `group members`, `group inspect`, `group adduser`, and `group removeuser` now accept an exact group name or a numeric ID; add and remove accept multiple usernames, report every result, and make already-satisfied membership changes successful no-ops.
- d0ac04f: BEHAVIOR CHANGE: failures no longer read as empty results. Commands that previously printed nothing and exited 0 when a fetch failed now report the error and exit non-zero, following the codebase's `Result<T>` pattern throughout. Affected surfaces: listing a PACS study or series that does not exist errors instead of showing an empty directory; `store list`/`store search` and `compute list` error when the store or CUBE is unreachable instead of showing no entries; plugin registration no longer defaults to the `host` compute resource when the compute fetch failed; `rm` on a feed fails when running jobs could not be cancelled instead of claiming success; a recursive scan that cannot list a subtree reports the exclusion instead of silently omitting it; batch job-status gaps and disconnected status fetches push visible warnings; the native VFS distinguishes "folder absent" from "could not verify" so probe failures no longer masquerade as missing directories; `cp` fails when path resolution fails rather than proceeding with a guessed path; join-edge resolution retries after a transient failure instead of permanently recording no joins; and the remote client reports invalid daemon messages instead of silently dropping them. Exit codes are now truthful end to end: `ls` reports an error status when any listing fails instead of aggregating failures into success, and `chell -c` derives its exit code from the command's envelopes, so a failed one-shot command exits non-zero even when the builtin did not set an exit code itself.
- 0e92d4d: Persist and reconcile daemon `/proc` checkpoints, fix wildcard listing of
  virtual executables, keep remote admin prompts on their originating surface,
  add a Unix-style `id` builtin for the current CUBE UID/GID projection and group
  memberships, and make versioned-plugin help, parameters, and README output
  compose correctly through terminals, pipes, and redirects.
- fa81126: Retain failed `/proc` topology sweep state and add `proc retry` to continue at
  the failed page without repeating already successful pagination work.
- Updated dependencies [66bc932]
- Updated dependencies [8ec8a4b]
- Updated dependencies [d0ac04f]
- Updated dependencies [886f09c]
- Updated dependencies [d0ac04f]
- Updated dependencies [22db63f]
- Updated dependencies [0e92d4d]
- Updated dependencies [590a943]
  - @fnndsc/cumin@3.9.0

## 3.5.5

### Patch Changes

- Carry backing resource IDs on VFS entries so cache-only virtual executable
  summaries can retain stable Pipeline identity.

## 3.5.4

### Patch Changes

- Add a lightweight registered-manifest projection, exact targeted Pipeline
  slug resolution, and connection-scoped manifest and hosted-plugin metadata
  caches.

## 3.5.3

### Patch Changes

- Project registered pipelines as typed invocation manifests, validate and merge
  sparse parameter/resource overlays, and create Workflows from complete node sets.
- Preserve plugin parameter values as typed data through Cumin execution.
- Updated dependencies
  - @fnndsc/cumin@3.8.4

## 3.5.2

### Patch Changes

- Export a typed feed-creation result so PACS, plugin, and future pipeline
  workflows can share the same feed/root identity contract.
- Updated dependencies
  - @fnndsc/cumin@3.8.3

## 3.5.1

### Patch Changes

- 6f0833a: Release the coordinated ChELL stack with deterministic `/proc` topology progress, complete visible-feed indexing, safe warm-up query gating, remote one-shot command completion, and refreshed daemon documentation.
- Updated dependencies [6f0833a]
  - @fnndsc/cumin@3.8.1

## 3.5.0

### Minor Changes

- e630f79: Draw registered CUBE pipelines with `pipeline diagram <id|name>` or the `/bin` shorthand `<pipeline> --diagram`. Bare output uses the same shallow tree machinery as feed diagrams, `--withargs` appends stored non-null plugin defaults, and `--signalflow` emits the same SignalFlow YAML dialect as feeds. `feed diagram <specifier>` is now a shallow alias of `feed tree`; feed graph commands accept IDs, `feed_N`, exact or unambiguous title searches, and infer the feed from the current `feed_N` directory when omitted.

### Patch Changes

- Updated dependencies [e630f79]
  - @fnndsc/cumin@3.8.0

## 3.4.0

### Minor Changes

- a1f6694: Feed-DAG data layer. Projects a feed's cached plugin-instance topology into a flat,
  surface-agnostic `FeedGraph` and resolves topological-join (`ts`) edges.

  - **cumin:** `ProcInstance` gains `pluginType` (authoritative `ts` detection) and
    `joinParentIDs` (cached join overlay); `ProcCache.joinParents_update`/`joinParents_get`
    and `feedInstanceIDs_get` (anchor-tree traversal).
  - **salsa:** `feedGraph_build` + `signature_compute` (a per-node topology signature — a
    hash of plugin name plus the sorted child signatures, status excluded — so surfaces can
    group isomorphic siblings without re-deriving the grouping); `feedJoins_ensure` /
    `nodeJoins_resolve` fetch a join node's `plugininstances` parameter and record its extra
    parents (sources minus the anchor).

- 01ab743: `feed tree` now builds the DAG **cache-first** from the warm ProcCache instead of
  re-crawling the feed on every call. It reuses already-loaded topology, fetches feed
  metadata only when missing or a placeholder, refreshes volatile status cheaply (one
  feed-scoped list call, active nodes only) when reusing a warm cache, and resolves join
  edges lazily. New salsa exports: `feedGraphData_ensure`, `feedMeta_ensure`,
  `feedInstances_ensureLoaded`, `feedStatus_refresh`.

### Patch Changes

- Updated dependencies [a1f6694]
  - @fnndsc/cumin@3.7.0

## 3.3.0

### Minor Changes

- 0d358c5: /proc now caches settled job status. A finished plugin instance
  (`finishedSuccessfully`, `finishedWithError`, `cancelled`) never changes, so its
  status is kept permanently once observed. Consequences:

  - Listing a fully-finished feed under `/proc/jobs` is instant — no status calls.
  - Live status for active feeds is refreshed with a single feed-scoped list call
    (the list response already carries `status`) instead of one detail fetch per node.
  - Reading a settled instance's `status` returns the cached value without an API call.

### Patch Changes

- Updated dependencies [0d358c5]
  - @fnndsc/cumin@3.6.0

## 3.2.6

### Patch Changes

- The PACS VFS content reader parses query folder ids with the same helper as the listing provider; `cat metadata.json` inside `/net/pacs/queries/...` directories works again (it failed with "Invalid query ID in path" on the modern `<desc>_qid:<id>` folder naming).

## 3.2.5

### Patch Changes

- Test coverage lock-in: global coverage ratchets raised and a 60% per-file floor enforced in CI. No runtime changes.
- Updated dependencies
  - @fnndsc/cumin@3.3.0
