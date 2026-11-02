# @fnndsc/chili

## 3.8.2

### Patch Changes

- Updated dependencies [f6790b6]
  - @fnndsc/menu@0.32.0
  - @fnndsc/cumin@3.29.5

## 3.8.1

### Patch Changes

- 56debd5: A read runs while another line works: `ls` in a browser comes back while a PACS pull runs in a console. Each command says what it changes of the session, and calypso runs lines side by side unless they change the same piece: a read holds nothing, `cd` holds the working directory, `gather` the cohort, and a command that has not said holds the whole session, so it waits and is waited for as before (#1273).

  Each line keeps its own slot in calypso (its surface, its questions, its STOP) and in the kernel (its cancellation, a played manifest's depth and recorder mute, and the directory it stands in, read once when it first asks), so the per-command hand-over a question used to need (`turn_leave`, `turn_resume`, `turn_abort`) is gone; a STOP names the line it reaches. `tree` and `du` scan a named folder where it stands (chili's `scan_do` takes a `folder`) instead of moving the shared directory there and back.

- Updated dependencies [41769da]
- Updated dependencies [0efbb7c]
- Updated dependencies [b8bc519]
  - @fnndsc/menu@0.31.0
  - @fnndsc/cumin@3.29.3

## 3.8.0

### Minor Changes

- 02c20bf: Every function name now says what it does: the 462 that put a preposition where the verb goes are renamed (#1227).

  The style guide names a function `<subject>[Qualifier]_<verb>[Adverb]`. Names such as `answerRows_of`, `seriesUID_ofPath`, `options_toParams` and `ask_onPane` put a preposition in the verb's place, which names the result without saying whether the function derives, parses, builds or renders it. They are now `answerRows_derive`, `seriesUID_parse`, `options_convertToParams` and `askOnPane_await`. A preposition may still qualify the verb (`x_readFromCache`) or the object (`askOnPane_await`); it may not start the method.

  `npm run lint:rpn` (`scripts/rpn-prepositions.mjs`) refuses a function, `const` function or underscored method whose method is, or starts with, `of`, `to`, `with`, `from`, `for`, `by`, `as`, `in`, `on` or `at`, and CI runs it. The exported names change with no aliases kept: nothing outside this repository imports them.

### Patch Changes

- Updated dependencies [fd1711f]
- Updated dependencies [4bc9d87]
- Updated dependencies [02c20bf]
- Updated dependencies [55e2041]
  - @fnndsc/menu@0.30.0
  - @fnndsc/cumin@3.29.0
  - @fnndsc/fond@0.6.0
  - @fnndsc/salsa@4.4.0

## 3.7.16

### Patch Changes

- Updated dependencies [e1d052d]
- Updated dependencies [a0fa450]
- Updated dependencies [05ec948]
- Updated dependencies [46bc80d]
  - @fnndsc/menu@0.29.0
  - @fnndsc/salsa@4.3.0
  - @fnndsc/cumin@3.28.6

## 3.7.15

### Patch Changes

- Updated dependencies [01fcb59]
- Updated dependencies [49ccdfd]
- Updated dependencies [49501d4]
- Updated dependencies [14f8fc1]
- Updated dependencies [dcdc6cd]
  - @fnndsc/fond@0.5.1
  - @fnndsc/menu@0.28.0
  - @fnndsc/cumin@3.28.4

## 3.7.14

### Patch Changes

- Updated dependencies [1e637f1]
  - @fnndsc/fond@0.5.0
  - @fnndsc/cumin@3.28.3
  - @fnndsc/salsa@4.2.1

## 3.7.13

### Patch Changes

- Updated dependencies [21649d1]
  - @fnndsc/menu@0.27.0
  - @fnndsc/cumin@3.28.2

## 3.7.12

### Patch Changes

- Updated dependencies [e9d9540]
  - @fnndsc/fond@0.4.0
  - @fnndsc/salsa@4.1.0
  - @fnndsc/cumin@3.27.20

## 3.7.11

### Patch Changes

- Updated dependencies [c7acb1b]
- Updated dependencies [fb6813d]
  - @fnndsc/salsa@4.0.6
  - @fnndsc/menu@0.26.0
  - @fnndsc/cumin@3.27.19

## 3.7.10

### Patch Changes

- Updated dependencies [66f1956]
  - @fnndsc/menu@0.25.0
  - @fnndsc/cumin@3.27.17

## 3.7.9

### Patch Changes

- Updated dependencies [90b7688]
- Updated dependencies [554fd24]
- Updated dependencies [90b7688]
- Updated dependencies [6bde343]
  - @fnndsc/menu@0.24.0
  - @fnndsc/salsa@4.0.3
  - @fnndsc/cumin@3.27.15

## 3.7.8

### Patch Changes

- Updated dependencies [c73c81b]
- Updated dependencies [1a2a0d0]
  - @fnndsc/menu@0.23.0
  - @fnndsc/cumin@3.27.14

## 3.7.7

### Patch Changes

- 1b93202: A large file downloads, and a file in a feed shared with you downloads (#1061). A file stream has no 30 s deadline any more: CUBE held a 3.7 GB DICOM's first byte for up to a minute, and the old deadline killed every attempt. A watchdog fails a transfer only after two silent minutes, and says so. A file in a colleague's shared feed is read through CUBE's file browser, which serves it where `/userfiles/` answers 403. `download` names the kernel's reason (a stall, a refusal, a file too large to read whole) instead of "Failed to download file", and a file over 256 MB is never read whole into memory after a failed stream. ARGUS's DOWNLOAD streams through the daemon with its length in the header, so the browser draws its own progress and the daemon holds nothing whole.
- Updated dependencies [e29bf91]
- Updated dependencies [a0f0160]
- Updated dependencies [1b93202]
  - @fnndsc/cumin@3.27.12
  - @fnndsc/salsa@4.0.1
  - @fnndsc/menu@0.22.1

## 3.7.6

### Patch Changes

- 423971a: Making folders with parents never puts one over a file or beneath one, and missing parents no longer fail the command. `mkdir -p a/b/c` had made the folders and still exited 1, because looking up a parent that was not there left its complaint on the error stack. `mkdir` now goes through the backend's filesystem. fond's mounts gain `mkdirTree` (a folder and its parents in one step, as CUBE makes them), and the contract holds it: EEXIST for anything already there, ENOTDIR beneath a file. A mount without `mkdirTree` is walked one parent at a time. Under `-p`, something already there counts as done only when it is a folder; a file is `File exists`. salsa's `folderPath_holder` names the nearest thing holding a path or a parent of it. The fs views (`mkdir_render` and its kin) live in fond.
- a12c6fc: Nothing changes at the prompt: `ls` renders through fond, not chili, in every listing exactly as before (#1001). fond gains `grid_render`, `long_render`, `size_format` and `listingItems_sort`, and a listing look: the core's kinds (file, folder, link, mount) plus a backend's, each with its long-view mark, and how a name is coloured. Its one dependency is `chalk`. chili's `ls` views wrap fond with the ChRIS look: plugins, pipelines, and jobs with their status column, coloured by the colour configuration. brasa's listings render with the installed backend's look, or plainly when it has none. `VFSItem` gains `tags`.
- fb31bef: A folder and a file never share one path. CUBE lets them, and removing the folder then damages the file's record so every listing of the parent fails (CUBE #732). `mkdir` over a file answers `mkdir: cannot create directory 'X': File exists`, and beneath a file `Not a directory`. `touch` or a write over a folder answers `Is a directory`. `mv` onto anything that already holds the destination refuses (`Destination exists`). `cp -r` skips a file whose name a folder holds, with a warning. `rm` refuses a path that a folder and a file already share, removing neither. salsa's `pathHolders_find` names what holds a path.
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
  - @fnndsc/cumin@3.27.11

## 3.7.5

### Patch Changes

- Updated dependencies [8d15909]
  - @fnndsc/menu@0.21.0
  - @fnndsc/cumin@3.27.10

## 3.7.4

### Patch Changes

- 5bb17f6: Nothing changes for chell, ARGUS or porter users: a listing entry's shape now belongs to menu, with an open type. `ListingItem` and `listingItemSchema` are menu's, so a backend can list its own kinds beside `dir`, `file`, `link` and `vfs`; fond's `VFSItem.type` opens the same way, and chili re-exports the type.
- Updated dependencies [e1deb53]
- Updated dependencies [5bb17f6]
  - @fnndsc/salsa@3.21.2
  - @fnndsc/menu@0.20.0
  - @fnndsc/cumin@3.27.9

## 3.7.3

### Patch Changes

- f6853fb: Asking chili for its version now prints the installed version and exits cleanly, through `chili --version`. It said 1.0.1 whatever was installed, then printed a CommanderError stack.

## 3.7.2

### Patch Changes

- d3618fb: chell installed from npm no longer prints "Could not load color config" before listings. chili's package now carries `config/colors.yml`, and a missing color file is reported once per process instead of on every call.
- Updated dependencies [df34da0]
  - @fnndsc/cumin@3.27.7

## 3.7.1

### Patch Changes

- ff80b59: A shared feed's `data` opens again. Listing a /proc link into a feed another user owns walked the owner's home asking for links, and that refusal, a side question, marked the whole `ls` an error though its listing came. chili's path walk no longer leaves its link probe's refusal on the error stack; it remembers the parent it could not read instead. When a listing then fails, `ls` says so after the reason (`ls: links in '/home/<owner>' could not be read; the path was walked as written`), because a link there, unseen, may be why the path was not found; when the listing succeeds nothing is said. ARGUS's files panel draws a listing the kernel sent even when the command is marked an error, and a refused press reads every line the kernel said, so the note reaches the bar too.

## 3.7.0

### Minor Changes

- 32e3919: `ls -l` shows a feed's tags (#831, slice 1c): a long listing that holds feeds (`feed_N` rows, as in `/proc/jobs` or `~/feeds`) prints each feed's tags as `#tags` after its title. The tags come from one map for the whole listing — the user's tags, then each tag's feeds — so a thousand feeds cost as many reads as the user has tags, never one per feed; the map is kept a minute and forgotten whenever a tag is added or removed here. A listing with no feed in it reads nothing.

### Patch Changes

- Updated dependencies [1c8b92d]
- Updated dependencies [e20fb09]
- Updated dependencies [ddbd551]
- Updated dependencies [32e3919]
- Updated dependencies [59399fe]
  - @fnndsc/cumin@3.27.0
  - @fnndsc/salsa@3.21.0

## 3.6.7

### Patch Changes

- 3320487: salsa: a touch carrying content REWRITES the file it finds.

  CUBE's upload does not replace. Uploading over a path that already held a file left the OLD content in place and still reported success, so anything written to the same path twice kept its first version forever — the surface's own cohort file was written on every change and had not changed since the first one. Content given for a path that already exists is a rewrite: the file there is removed first, and a removal that fails is reported instead of written over.

  chili's readout was the second half of the same lie. A touch that carried content now says it WROTE the file rather than created it, so replacing an operator's file never reads as making a new one.

- Updated dependencies [e74ce1d]
- Updated dependencies [3320487]
- Updated dependencies [a010cb0]
- Updated dependencies [7bba167]
- Updated dependencies [43b9440]
  - @fnndsc/salsa@3.18.2
  - @fnndsc/cumin@3.23.0

## 3.6.6

### Patch Changes

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

- Updated dependencies [f5c16fe]
- Updated dependencies [ec3ef9f]
- Updated dependencies [5a339f0]
- Updated dependencies [17964a9]
  - @fnndsc/salsa@3.13.0
  - @fnndsc/cumin@3.18.0

## 3.6.5

### Patch Changes

- 14f8ee8: Deletion works from any context. `rm` no longer depends on the session's
  current directory or a prior listing: `files_delete` anchors at the target's
  parent folder and loads its collection itself, and chili's `rm` passes that
  parent explicitly. New path-addressed deletion API: cumin
  `folder_deleteByPath` and salsa `folderByPath_delete`, which return only
  once the CUBE confirms the folder no longer resolves. Context writes are
  ordered after session-filename resolution, fixing a fresh session's first
  `cd` intermittently losing its value.
- 4da2673: POSIX rm -f semantics: a missing operand under `-f` is success, not an
  error, making remove-then-recreate scripts idempotent.
- Updated dependencies [14f8ee8]
- Updated dependencies [69b0617]
  - @fnndsc/cumin@3.11.0
  - @fnndsc/salsa@3.7.0

## 3.6.4

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

## 3.6.3

### Patch Changes

- 9ed47ad: Fix titled tables narrower than their title: negative padding computations threw a RangeError that replaced the entire table with "Error generating table". Title width now clamps, truncating gracefully at any table width.

## 3.6.2

### Patch Changes

- 66bc932: Add ChELL group membership commands and include current CUBE usernames in the
  live `/etc/group` projection.
- 8ec8a4b: Add explicit, command-scoped CUBE elevation with `sudo <command>`. The active surface collects an administrator identity and hidden password; a temporary CUBE client runs only the nested command, then the normal session is restored. Group membership and plugin registration now suggest a copyable `sudo` rerun after an authorization failure, and plugin registration no longer owns a separate interactive admin prompt.
- d0ac04f: Preserve failure causes and tighten cache contracts. Errors that were replaced by generic messages now carry their real cause: controller and handler creation failures name the underlying error instead of "no ChRIS context", `cat` shows the actual fetch failure, docker command failures surface stderr detail, context-set errors actually print, settings load/save failures are announced instead of silently using defaults or losing changes, unreadable berth and discovery files are named instead of reading as "no daemon", token-file read errors are distinguished from the logged-out state, and resource deletes report why they failed. Every remaining deliberate error absorption now carries a dated adjudication comment. Cache contracts: the PACS provider's decoded-query cache caches settled results only and is size-bounded; the object-context factory gains an eviction hook (`objContext_evict`) for deleted plugin or feed ids; `mv` and `cp` invalidate the whole affected listing subtree; and a new PACS query invalidates the cached `/net/pacs/queries` listing so it appears in the next `ls` immediately.
- 50e9bb1: Make CUBE group membership commands name-first and batch-capable. `group members`, `group inspect`, `group adduser`, and `group removeuser` now accept an exact group name or a numeric ID; add and remove accept multiple usernames, report every result, and make already-satisfied membership changes successful no-ops.
- d0ac04f: BEHAVIOR CHANGE: failures no longer read as empty results. Commands that previously printed nothing and exited 0 when a fetch failed now report the error and exit non-zero, following the codebase's `Result<T>` pattern throughout. Affected surfaces: listing a PACS study or series that does not exist errors instead of showing an empty directory; `store list`/`store search` and `compute list` error when the store or CUBE is unreachable instead of showing no entries; plugin registration no longer defaults to the `host` compute resource when the compute fetch failed; `rm` on a feed fails when running jobs could not be cancelled instead of claiming success; a recursive scan that cannot list a subtree reports the exclusion instead of silently omitting it; batch job-status gaps and disconnected status fetches push visible warnings; the native VFS distinguishes "folder absent" from "could not verify" so probe failures no longer masquerade as missing directories; `cp` fails when path resolution fails rather than proceeding with a guessed path; join-edge resolution retries after a transient failure instead of permanently recording no joins; and the remote client reports invalid daemon messages instead of silently dropping them. Exit codes are now truthful end to end: `ls` reports an error status when any listing fails instead of aggregating failures into success, and `chell -c` derives its exit code from the command's envelopes, so a failed one-shot command exits non-zero even when the builtin did not set an exit code itself.
- 0e92d4d: Persist and reconcile daemon `/proc` checkpoints, fix wildcard listing of
  virtual executables, keep remote admin prompts on their originating surface,
  add a Unix-style `id` builtin for the current CUBE UID/GID projection and group
  memberships, and make versioned-plugin help, parameters, and README output
  compose correctly through terminals, pipes, and redirects.
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

## 3.6.1

### Patch Changes

- 6f0833a: Release the coordinated ChELL stack with deterministic `/proc` topology progress, complete visible-feed indexing, safe warm-up query gating, remote one-shot command completion, and refreshed daemon documentation.
- Updated dependencies [6f0833a]
  - @fnndsc/cumin@3.8.1
  - @fnndsc/salsa@3.5.1

## 3.6.0

### Minor Changes

- e43f42a: Delegating an unknown chell command to chili no longer stalls or floods the terminal with context-init errors when the current directory is a pure-VFS path (`/proc`, `/net`, ...). chili now registers its file-group and plugin-context commands without resolving any ChRIS context — each controller is created lazily, only when a command's action runs — so an unrelated command (or a directory that is not a ChRIS folder) pays no network cost and produces no setup-time error wall. chili also exports `commandNames_get()`, a cheap network-free listing of its top-level commands. In brasa, the "delegating to chili" notice is now emitted on the live sink before chili runs, so it appears ahead of chili's output instead of after it; and a command chili does not know (a typo, a host program) is reported as `command not found` without delegating at all.

## 3.5.0

### Minor Changes

- a0d3df5: chili's command layer no longer prints straight to the console. A new output seam (`screen/output.ts`) routes all command output through a swappable `ChiliWriter` — `chiliLog`/`chiliErrLog`/`chiliWrite` — whose default delegates to the process console, so the standalone CLI is unchanged. A host captures a run's output with `chili_capture(fn)`, and `run_capture(argv)` runs a single command with its output collected as strings, so an in-process host (the brasa engine) can drive chili headless without a console monkeypatch.

## 3.4.0

### Minor Changes

- d69b086: Add sans-I/O rendering variants alongside the existing printing ones, so hosted surfaces can carry command output in an envelope rather than relying on the caller to capture `console.log`: `pluginParameters_manRender` (view), `PluginContextGroupHandler.parameters_listManRender` / `parameters_fieldsRender`, and `BaseGroupHandler.resourceFields_render`. The original printing forms are unchanged and still used by chili's own CLI.

## 3.3.0

### Minor Changes

- asciidoctor 3 → 4 (dependency-free, drops the deprecated glob/inflight chain); the man renderer's `browser_open` is now async. Removed the unused `node-fetch` dependency (Node ≥ 22 global fetch).

### Patch Changes

- Updated dependencies
  - @fnndsc/cumin@3.4.0

## 3.2.6

### Patch Changes

- Test coverage lock-in: global coverage ratchets raised and a 60% per-file floor enforced in CI. No runtime changes.
- Updated dependencies
- Updated dependencies
  - @fnndsc/cumin@3.3.0
  - @fnndsc/salsa@3.2.5
