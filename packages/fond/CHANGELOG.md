# @fnndsc/fond

## 0.6.2

### Patch Changes

- 0598ad2: The error stack can take back messages from a scope as they were, without a second caller prefix.

  `errorStack.stack_restore(messages)` puts messages drained from a `scope_run` onto the stack outside it, so work run side by side in scopes of its own still hands its notes to the caller.

## 0.6.1

### Patch Changes

- 0728336: A file in a run's output opens from RUNS through a link, as every pl-dircopy output holds: it reads where it is stored.

  A path under a node's `data` in `/proc/jobs` that passes through a `.chrislink` was read at the feed path with the link unfollowed, so CUBE found no folder (`Failed to initialize ChRIS context for files`) while `ls` of the same folder listed the file. Every reader and lister now asks one resolver, `storePath_resolve` in brasa, where a path is stored: `~` and relative paths, a mount's own answer (`/proc/jobs/…/data` is the job's output folder, through fond's new `VFSProvider.storePath_resolve`), and the store's links at any depth, in turn. `cat`, `wc` and the other text filters, `ls` and the listings ARGUS draws, the `/vfs` byte route, `download`, `cp`, wildcards, `dcm` and the berth's reads go through it, and the per-command copies of the `/proc` mapping and the link walk (`file_read`'s, `download`'s and `dcm`'s, and the berth's link walk) are gone. `cp` out of a node's data, refused before as a read-only file system, copies.

## 0.6.0

### Minor Changes

- 02c20bf: Every function name now says what it does: the 462 that put a preposition where the verb goes are renamed (#1227).

  The style guide names a function `<subject>[Qualifier]_<verb>[Adverb]`. Names such as `answerRows_of`, `seriesUID_ofPath`, `options_toParams` and `ask_onPane` put a preposition in the verb's place, which names the result without saying whether the function derives, parses, builds or renders it. They are now `answerRows_derive`, `seriesUID_parse`, `options_convertToParams` and `askOnPane_await`. A preposition may still qualify the verb (`x_readFromCache`) or the object (`askOnPane_await`); it may not start the method.

  `npm run lint:rpn` (`scripts/rpn-prepositions.mjs`) refuses a function, `const` function or underscored method whose method is, or starts with, `of`, `to`, `with`, `from`, `for`, `by`, `as`, `in`, `on` or `at`, and CI runs it. The exported names change with no aliases kept: nothing outside this repository imports them.

## 0.5.1

### Patch Changes

- 01fcb59: A long listing stays aligned when an owner is long, such as a cloud user who is an e-mail address.

  `ls -l` pads the owner column to the widest owner in the listing, never narrower than ten. The text filters (`head tail wc sort uniq cut`) no longer say a system program "cannot read ChRIS files" in a session over another backend: they say the session's files, in their refusals and their help.

## 0.5.0

### Minor Changes

- 1e637f1: A backend's container kinds are folders to every tool.

  cd, ls of a file, and a read that fails on a folder decided folder-ness by naming item types (dir, vfs, job). A backend's listing look already says which of its kinds hold other items; the tools now ask it, through fond's itemType_isContainer and a container test the dispatcher is told at engine creation. A ChRIS session is unchanged: its jobs were already containers in its look. A stratus session can now cd into a compartment.

## 0.4.0

### Minor Changes

- e9d9540: Questions about runs are now answered from the session's job index with find over /proc/jobs, asking CUBE nothing. -plugin and -status test what a job ran and how it ended, so find /proc/jobs -plugin pl-dylld -status finishedWithError lists every failed run. A mount can answer a whole subtree for find; /proc/jobs does.

## 0.3.0

### Minor Changes

- a12c6fc: Nothing changes at the prompt: `ls` renders through fond, not chili, in every listing exactly as before (#1001). fond gains `grid_render`, `long_render`, `size_format` and `listingItems_sort`, and a listing look: the core's kinds (file, folder, link, mount) plus a backend's, each with its long-view mark, and how a name is coloured. Its one dependency is `chalk`. chili's `ls` views wrap fond with the ChRIS look: plugins, pipelines, and jobs with their status column, coloured by the colour configuration. brasa's listings render with the installed backend's look, or plainly when it has none. `VFSItem` gains `tags`.
- 1681476: A failed copy says why without the stack's internal markers (no more `cp: [StaticVfsProvider.cp …] | cp: …`). Underneath, every filesystem operation answers with a reason (#1001). fond adds the filesystem contract: `VfsErrno`, `VfsOutcome` and `vfsRefusal_text`, which keeps the shell's existing wording for each refusal. Mount operations (read, readBinary, write, mkdir, rmdir, rename, cp, and the new rm and rmTree) return an outcome instead of a boolean or `Result`. The dispatcher asks the fallback too, through its path resolver. fond also adds `MemoryVfsProvider`, a complete in-memory mount, and `VFS_CONTRACT`, the cases any mount must pass. salsa's mounts and dispatcher return outcomes, so its callers change (a major bump). A mount's own message travels as the reason, so every refusal reads as before. proc's unreachable `rm` becomes `feedJobs_cancel`.

### Patch Changes

- 11853c6: Reading a folder as a file says `Is a directory`, on every mount (#1026). A home folder had answered with CUBE's words for a missing file, `/proc` and `~` with "No files found in directory", `/bin` with "Unknown /bin entry", and `/proc/jobs` with nothing at all and exit 0. The dispatcher now answers EISDIR for any failed read of a path its parent lists as a folder. /proc reads no folder or unknown name as empty text. The native mount keeps CUBE's words only for a path that is missing. cat names the path once.
- ebd7b3e: Nothing changes at the prompt: `cp` goes through the backend's filesystem (#1001). Into a folder the destination names, the copy keeps its name, decided by the core as mv decides it. The mount's refusal is said once, after one `cp:`. The memory mount refuses a copy of a file onto a folder (EISDIR) or of a folder onto a file (ENOTDIR), as a disk does.
- 423971a: Making folders with parents never puts one over a file or beneath one, and missing parents no longer fail the command. `mkdir -p a/b/c` had made the folders and still exited 1, because looking up a parent that was not there left its complaint on the error stack. `mkdir` now goes through the backend's filesystem. fond's mounts gain `mkdirTree` (a folder and its parents in one step, as CUBE makes them), and the contract holds it: EEXIST for anything already there, ENOTDIR beneath a file. A mount without `mkdirTree` is walked one parent at a time. Under `-p`, something already there counts as done only when it is a folder; a file is `File exists`. salsa's `folderPath_holder` names the nearest thing holding a path or a parent of it. The fs views (`mkdir_render` and its kin) live in fond.
- e1215ef: Listing `/usr` exits 0, and `cat` ends a file with its own newline (#1032, #1033). A folder holding only mounts had listed them and still failed, because the store's "nothing here" was left on the error stack. cat had added a newline to every file, so one ending in a newline printed a blank line after it and `cat f > out` wrote a longer file; it now adds one only to a file without.

## 0.2.0

### Minor Changes

- e1deb53: Nothing changes for chell, ARGUS or porter users: the virtual filesystem's contracts and dispatcher now live in fond. fond's dispatcher knows no backend; salsa's CubeVfsDispatcher registers CUBE's mounts on it in the same order, so every path routes as before.

### Patch Changes

- 5bb17f6: Nothing changes for chell, ARGUS or porter users: a listing entry's shape now belongs to menu, with an open type. `ListingItem` and `listingItemSchema` are menu's, so a backend can list its own kinds beside `dir`, `file`, `link` and `vfs`; fond's `VFSItem.type` opens the same way, and chili re-exports the type.

## 0.1.2

### Patch Changes

- b0d414b: fond's README and description now say what fond is, not where the backend-neutral work stands. fond holds the pieces every layer needs, whatever the backend; status lines would have gone stale.

## 0.1.1

### Patch Changes

- 803a423: fond's README now says what the package is for and how to use it, with examples of Result and the error stack. It also explains why the stack is one shared instance and where fond sits in the stack.
