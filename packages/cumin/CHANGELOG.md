# @fnndsc/cumin

## 3.29.5

### Patch Changes

- Updated dependencies [f6790b6]
  - @fnndsc/menu@0.32.0

## 3.29.4

### Patch Changes

- c742135: An identity that sees thousands of feeds can log in again: the boot no longer waits on CUBE's slow feed list (#1280). The token check reads `users/` instead of the API root, which is the feed list and took up to 22 s for `chris`; a CUBE that does not answer the check is said to be silent, never to have refused the token. Each client reads its root once for every caller, and feed-list pages wait 120 s instead of chrisapi's 30. A cold boot walks the feed index behind the listening daemon, as a restored one already did, so the session answers the door before its 120 s wait runs out; a `/proc` read that arrives first joins the walk instead of starting a second.

## 3.29.3

### Patch Changes

- Updated dependencies [41769da]
- Updated dependencies [0efbb7c]
- Updated dependencies [b8bc519]
  - @fnndsc/menu@0.31.0

## 3.29.2

### Patch Changes

- b53c0cf: A run started from inside a node's output now attaches to that node, not to a folder that merely looks like one (#1268). In `…/pl-dircopy_734517/data/subject_01`, a plugin or pipeline run used to start from instance 1, because the path reader took the deepest folder named `<anything>_<number>`. The node is now the last `<name>_<id>` of the chain right after `feed_N`, and nothing at or below a `data` folder counts. Plugins, pipelines and `proc here` all read it this way.

  A play whose starting folder cannot be given back at its end (removed during the play) now says so in one line instead of throwing over the play's own result.

## 3.29.1

### Patch Changes

- eba14cc: A folder you just removed no longer comes back in `ls`. CUBE accepts a folder's removal (202) and finishes it a moment later; until then its parent still lists the folder, and a listing read in that moment (the `ls` after `rm -r`, a pane's refresh) was kept as current, so the removed folder stood in `ls ~` for as long as the cache trusted that listing.

  `rm -r` and `rmdir` now return once CUBE has finished: they wait, 15 seconds at most, for the parent to stop naming the folder, and say so in words if it still does (`CUBE accepted the removal of … but still lists it after 15s`).

  The listing cache also no longer keeps a listing that a change overtook while it was being read. A read takes a stamp before it asks CUBE (`stamp_take()`), and `cache_set(path, data, { since })` does not keep a listing whose folder, a tree above it, or the whole cache was invalidated after that stamp. brasa's VFS takes the stamp for an `ls` and for the refresh behind a stale one.

## 3.29.0

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
  - @fnndsc/fond@0.6.0

## 3.28.6

### Patch Changes

- Updated dependencies [e1d052d]
- Updated dependencies [05ec948]
- Updated dependencies [46bc80d]
  - @fnndsc/menu@0.29.0

## 3.28.5

### Patch Changes

- ef93267: A /proc checkpoint shard that cannot be read or parsed costs its one feed, not the whole checkpoint. On pangea one shard on a failing disk sector (EIO) refused 738 good ones and the session booted cold; now that shard is named as torn (`feed 2291: unreadable (EIO)`), its feed walks again, and the rest restores (#1209).

## 3.28.4

### Patch Changes

- Updated dependencies [01fcb59]
- Updated dependencies [49ccdfd]
- Updated dependencies [49501d4]
- Updated dependencies [14f8fc1]
- Updated dependencies [dcdc6cd]
  - @fnndsc/fond@0.5.1
  - @fnndsc/menu@0.28.0

## 3.28.3

### Patch Changes

- Updated dependencies [1e637f1]
  - @fnndsc/fond@0.5.0

## 3.28.2

### Patch Changes

- Updated dependencies [21649d1]
  - @fnndsc/menu@0.27.0

## 3.28.1

### Patch Changes

- d6337c6: A folder made with mkdir -p is there at once for touch, ls and find, its new parents included.

  `mkdir -p a/b` makes `a` in the same CUBE step and says nothing of it, so a folder lookup kept as a miss for `a`, and the listings above it, still said it was absent: `touch a/x` answered "No such file or directory" and `find` saw nothing beneath. An invalidated folder now drops the misses kept for every folder above it, and `mkdir -p` forgets each listing above the new folder up to the first that already held its child. The smoke gains a `find` scenario: POSIX order and predicates on a scratch tree, and `/proc/jobs` judged whole from the index with no CUBE request.

## 3.28.0

### Minor Changes

- 20cd854: The job index keeps which pipeline run made each job, and find asks it with -pipeline and -workflow, CUBE never asked.

  Each `/proc/jobs` job keeps its CUBE row's `pipeline_name` and `workflow_id` (a job run directly keeps null), saved in the checkpoint. Jobs restored from an older checkpoint are read again once, feed by feed on six lanes, behind the prompt. `find /proc/jobs -pipeline 'FreeSurfer*'`, `-pipeline ''` (a direct run) and `-workflow ID` answer from the index; a job whose run is not known yet is not judged, and `find` names how many on stderr instead of dropping them silently.

## 3.27.20

### Patch Changes

- Updated dependencies [e9d9540]
  - @fnndsc/fond@0.4.0

## 3.27.19

### Patch Changes

- Updated dependencies [fb6813d]
  - @fnndsc/menu@0.26.0

## 3.27.18

### Patch Changes

- b1bffe1: A warm `ls`, `cd` or `cat` asks CUBE nothing. Whether a path is a folder comes from the memoised folder lookup, not a fresh listing of its parent; a lookup that found nothing is kept as long as a listing; /etc's compute.yaml and passwd and the /usr/share plugin records are kept. /proc/workflows, which walked every workflow on the CUBE, is unmounted (docs/proc.adoc).

## 3.27.17

### Patch Changes

- Updated dependencies [66f1956]
  - @fnndsc/menu@0.25.0

## 3.27.16

### Patch Changes

- d26f22c: Listing /proc/jobs and entering a feed no longer wait on CUBE: the roster check runs behind the answer after 250 ms. A session booted from a door's token keeps its folder lookups memoised, as a password boot always did; a lookup that finds no folder (a shared feed's own path) is kept 15 seconds instead of asked again by every caller; `ls` reads a listing once; a parent's fresh listing answers whether a child is a folder; the PACS server list is kept a minute. The terminal console's text is the transcript's size again.

## 3.27.15

### Patch Changes

- Updated dependencies [90b7688]
- Updated dependencies [554fd24]
- Updated dependencies [6bde343]
  - @fnndsc/menu@0.24.0

## 3.27.14

### Patch Changes

- Updated dependencies [c73c81b]
- Updated dependencies [1a2a0d0]
  - @fnndsc/menu@0.23.0

## 3.27.13

### Patch Changes

- 9065319: A feed shared with you is marked NEW until you open it, across logins (#1065). RUNS leads with a NEW SINCE YOUR LAST VISIT block, each row marked with who shared it, and the bar counts them. Opening a feed takes its mark off, and CLEAR NEW takes them all. `proc feeds --new` lists them and `proc seen` clears them. Your own feeds and public feeds are never marked.
- Updated dependencies [9065319]
  - @fnndsc/menu@0.22.2

## 3.27.12

### Patch Changes

- e29bf91: A feed shared to you is seen on your next look at the roster, not after the next ten-minute walk (#1058). The roster's delta reads each collection's newest page and walks whole when the total moved, so a share, an unshare or a deletion lands on the visit that follows it. `proc feeds <q>` matches a feed's title, its `feed_N` name and its id; a bare id the roster lacks is asked of CUBE live and adopted, or refused with why (not shared with you, or shared to a group you are not in). `ls /proc/jobs/feed_N` asks the same way. In ARGUS a RUNS filter that names a feed by id and matches nothing asks the session too: the row arrives marked, or the field says what CUBE answered. The roster frame gains REFRESH (`proc feeds --fresh`), and the bar says `CHECKING CUBE FOR THE FEED LIST…` while any walk runs and `FEED LIST CURRENT · n NEW` when it lands.
- 1b93202: A large file downloads, and a file in a feed shared with you downloads (#1061). A file stream has no 30 s deadline any more: CUBE held a 3.7 GB DICOM's first byte for up to a minute, and the old deadline killed every attempt. A watchdog fails a transfer only after two silent minutes, and says so. A file in a colleague's shared feed is read through CUBE's file browser, which serves it where `/userfiles/` answers 403. `download` names the kernel's reason (a stall, a refusal, a file too large to read whole) instead of "Failed to download file", and a file over 256 MB is never read whole into memory after a failed stream. ARGUS's DOWNLOAD streams through the daemon with its length in the header, so the browser draws its own progress and the daemon holds nothing whole.
- Updated dependencies [a0f0160]
  - @fnndsc/menu@0.22.1

## 3.27.11

### Patch Changes

- Updated dependencies [183aa7d]
- Updated dependencies [11853c6]
- Updated dependencies [ebd7b3e]
- Updated dependencies [27f3021]
- Updated dependencies [423971a]
- Updated dependencies [a12c6fc]
- Updated dependencies [6752575]
- Updated dependencies [e1215ef]
- Updated dependencies [1681476]
  - @fnndsc/menu@0.22.0
  - @fnndsc/fond@0.3.0

## 3.27.10

### Patch Changes

- Updated dependencies [8d15909]
  - @fnndsc/menu@0.21.0

## 3.27.9

### Patch Changes

- Updated dependencies [e1deb53]
- Updated dependencies [5bb17f6]
  - @fnndsc/fond@0.2.0
  - @fnndsc/menu@0.20.0

## 3.27.8

### Patch Changes

- 1a5c7ca: Nothing changes for chell, ARGUS or porter users: cumin takes Result and errorStack from the new @fnndsc/fond. It re-exports both, so every import still works, and the error stack stays one shared instance. The login probe export is renamed `url_probe` (was `urlProbe`) to follow the naming convention.
- Updated dependencies [803a423]
  - @fnndsc/fond@0.1.1

## 3.27.7

### Patch Changes

- df34da0: A failed login now says what failed, instead of always blaming the credentials. An untrusted TLS certificate names the host, the code and `NODE_EXTRA_CA_CERTS`; an unreachable CUBE says so with the code; only CUBE refusing the login mentions the password. The same holds for token logins, `sudo`, and porter's login page.

## 3.27.6

### Patch Changes

- d988570: A /proc checkpoint with one torn feed shard restores every other feed instead of being refused whole. A shard whose graph does not stand on its own (an instance naming a parent or join parent the shard does not hold, a twin, a stray, a cycle) is left out and named; its feed stays in the roster with no topology and is walked again. On titan one such shard, 475 of a feed's 477 instances, refused 210,010 instances and a restarted session booted cold.

## 3.27.5

### Patch Changes

- Updated dependencies [5a0eef5]
  - @fnndsc/menu@0.19.0

## 3.27.4

### Patch Changes

- Updated dependencies [73c0087]
  - @fnndsc/menu@0.18.0

## 3.27.3

### Patch Changes

- 1c7461b: An admin request CUBE refuses now says why. Admin POSTs are sent directly rather than through chrisapi's request helper, which replaced any non-Collection+JSON error body (Django REST field errors, Django's HTML error pages) with "Bad server response!". The refusal reads `CUBE refused POST <url> (HTTP <status>): <CUBE's own words>`, from field errors, a `detail`, a Collection+JSON error, or the text of an HTML page.

## 3.27.2

### Patch Changes

- 2d26368: Four defects the smoke suite's reds were hiding, fixed. `feed rm` now drops the feed from the session's index at once, so the RUNS roster stops listing a feed this session removed. The RUNS pane records the cwd on every promptline, so a pick is no longer replaced by a stale "move" minutes later. A follow superseded by a hand pick no longer takes the pane when its answer arrives late. RUNS pressed over a graph now leaves the graph whole (watch released, title and canvas cleared), and a feed listing brought by another command no longer pulls the roster over a graph.
- Updated dependencies [51315ec]
- Updated dependencies [33e4f1d]
- Updated dependencies [fe4b6b4]
  - @fnndsc/menu@0.17.0

## 3.27.1

### Patch Changes

- Updated dependencies [685ed59]
  - @fnndsc/menu@0.16.0

## 3.27.0

### Minor Changes

- 1c8b92d: A feed's name and sharing, whole, in the kernel (#853, slice 1). `/proc/jobs/feed_N/title` is writable: its first line renames the feed (`touch --withContents=`, `edit`), and the roster says so at once. `setfacl` speaks every entry CUBE has: `-m u:<user>:r`, `-m g:<group>:r`, `-m o::r` (public) and `-m o::-` (private again); `-x u:<user>` and `-x g:<group>` withdraw a grant (a feed that held none is said). `chmod o+r` / `o-r` is the other entry spelled as a mode. `getfacl` shows users, groups and `other::`. A feed is also named by `/proc/jobs/feed_N`. `feeds share` is retired and refuses by name; SHARE's question no longer says a grant is permanent; the access and tag verbs get a help category. cumin gains `feedAccess_read`, `feedShare_group`, `feedShare_revoke` and `feed_rename`.
- ddbd551: A feed's tags are kernel-covered (#831, slice 1a): cumin's `feedTags_list`, `feedTag_add` (the user's tag of that name, made if missing; idempotent) and `feedTag_remove` (the tagging goes, the tag stays); brasa speaks them as an extended attribute — `getfattr feed_12` dumps them, `setfattr -n tag -v urgent feed_12` hangs one, `setfattr -x tag -v urgent feed_12` takes it off, `setfattr -x tag feed_12` takes every tag off. A feed is named by id, feed_N, a /feeds/ path or /proc/jobs/feed_N; another attribute or flag is refused by name.
- 32e3919: `ls -l` shows a feed's tags (#831, slice 1c): a long listing that holds feeds (`feed_N` rows, as in `/proc/jobs` or `~/feeds`) prints each feed's tags as `#tags` after its title. The tags come from one map for the whole listing — the user's tags, then each tag's feeds — so a thousand feeds cost as many reads as the user has tags, never one per feed; the map is kept a minute and forgotten whenever a tag is added or removed here. A listing with no feed in it reads nothing.
- 59399fe: Tags are a vocabulary of folders under `/proc/tags` (#831, slice 4a). `ls /proc/tags` lists your tags (an unworn one too); `ls /proc/tags/<tag>` lists the feeds wearing it as links to `/proc/jobs/feed_N`, and `cd` through one lands in the feed. `mkdir /proc/tags/<name>` makes a tag, `rmdir` deletes one no feed wears ("Directory not empty" otherwise), and `mv` renames one. `setfattr -n tag -v <name>` no longer makes a tag: naming one that does not exist is an error naming the cure (`mkdir /proc/tags/<name>`). `rm` under `/proc/tags` is refused and names the verb that does the job. New builtin `rmdir` (empty folders only, as on Linux, on the store and in projections); `mkdir` and `mv` route a projection's paths to it, and a projection that makes or renames nothing refuses by name ("Read-only file system", "Invalid cross-device link"). The old read-only `/tags` projection is retired. cumin gains `tags_index`, `tag_create`, `tag_delete`, `tag_rename` over one cached index of the user's tags and their feeds.

### Patch Changes

- Updated dependencies [2826f2b]
- Updated dependencies [c1cf57e]
- Updated dependencies [51da853]
  - @fnndsc/menu@0.15.0

## 3.26.0

### Minor Changes

- 4864a34: `netstat`: the wire is a readout. The kernel keeps a ledger of every request it makes to CUBE (Node's diagnostics channels, nothing patched) — count since the session or the last reset, by endpoint family with time spent, the last few timed — and `netstat [-n <count>] [-r]` reads it as text and as the `net.stats` model.

### Patch Changes

- fbb1579: One folder lookup per path per session: `filebrowser/search?path=` is memoised through the listing cache (shared in flight, a miss never kept, dropped by the same invalidations the listings get), so a navigation no longer asks CUBE three times for the same path.
- 576b948: A group's members are read off its membership page: a membership row names its user (`user_id`, `user_username`), so `members_getAll` no longer fetches every member one by one — the boot's group warm asked CUBE for 51 users one by one on the dev CUBE and now asks for none; the linked user is fetched only for a row that does not name one. And the group items the one groups listing served are kept per client, so a group's members are read off its item instead of listing the group by id first (73 searches on a 73-group CUBE).
- 7fb4c21: A pipeline is resolved once per session: `pipeline_resolve` keeps its answer on the connection's client (by the specifier asked, the name and the id), the chrisapi item a search or a get served is kept beside it, and `pipeline_get` reads the pipings off that item instead of listing the pipeline again — a `pipeline diagram` costs at most three requests the first time (the id, the pipings, the defaults) and none the second; a /bin slug (`<base>_idN`) is resolved by its id outright instead of a name search that always missed and then the id as a fallback.
- Updated dependencies [4864a34]
  - @fnndsc/menu@0.14.0

## 3.25.0

### Minor Changes

- fbd3f0a: Data facts reader v2: a series in CUBE's PACS store is described by CUBE's own series record (asked once per patient) before any header is read, and each feed records `sourceFeed` when its data lies in another feed's output. Under DATA that lineage is drawn as a faint thread from the source feed's root (`joinFaint`: a thread, never a tube).

### Patch Changes

- Updated dependencies [fbd3f0a]
- Updated dependencies [fbd3f0a]
  - @fnndsc/menu@0.13.0

## 3.24.0

### Minor Changes

- e7f82dd: The /proc index can keep what each feed's data is (`ProcFeedDataFacts`: format, and for DICOM the modality and series description), persisted in the feed's checkpoint shard; a shard written before facts existed restores as before, and malformed facts are dropped without losing the feed's topology.
- 0f9ae74: The universe laid out once per identity: `proc layout <name>` answers where a surface last laid the universe out under a layout, and `proc layout put <name> <places>` keeps it beside the index checkpoint. ARGUS puts each settled layout and, in a browser that keeps none, draws from the session's copy at once, settling only feeds new since.

### Patch Changes

- Updated dependencies [d1da8ac]
- Updated dependencies [0f9ae74]
- Updated dependencies [d8e160c]
  - @fnndsc/menu@0.12.0

## 3.23.2

### Patch Changes

- 6b55e72: cumin: a finished sweep is saved whole. The checkpoint watcher dropped everything the cold sweep emitted (it was not yet current) and ignored the moment the cache became current, so a session whose sweep finished on a quiet CUBE wrote a few shards from later visits and never a roster, and its next boot was cold. Becoming current now writes the roster and every shard.

## 3.23.1

### Patch Changes

- 247bf09: cumin: a feed takes its shape from the instances the index holds, not from a walk down from its root. CUBE lists plugin instances newest first, so a cold sweep meets a feed's leaves long before its root, and the landing shape a surface draws — the UNIVERSE — stayed empty for the whole of a large feed until its oldest instance arrived. Per-feed roll kept on `instance_add`/`instance_remove`; `pluginChain_of`, `pluginGroups_of` and `instancesForFeed_count` read it; an instance whose parent has not landed stands as a root until it has.
- 50f8a4e: cumin: a job group carries `errored`, how many of its count ended in error.
- c82f514: cumin: a landed feed carries its title, so a surface can name the molecule it draws.
- Updated dependencies [dac2d96]
- Updated dependencies [50f8a4e]
- Updated dependencies [c82f514]
  - @fnndsc/menu@0.11.0

## 3.23.0

### Minor Changes

- 7bba167: The door hands a token: a session can be started by a front that already logged the operator in.

  Today a session is started by the operator, at a terminal, with a password: `chell user@url -p … --daemon`. A login front on a shared host — the porter, the display manager the browser surface needs — exchanges the password for a CUBE token itself and holds the token, never the password. This is the seam that lets it start a session with what it holds.

  - cumin `connection_connectWithToken({ user, url, token })`: proves the token against the server BEFORE writing anything, so a refusal leaves the saved context alone; never exits the process; the refusal travels in the outcome, not on the error stack.
  - brasa `sessionConnect_withToken(user, url, token)`: the headless connect beside `sessionConnect_fromSaved`, setting the context the way a credentialed boot does and leaving the working directory as it was.
  - chell `--auth-token-stdin`: the token comes in on stdin, one line, never on argv where `ps` shows it to the host. Refuses by name: without a `<user>@<url>`, beside `--password`, or with no line on the stream. The boot row reads `Connect  Connected to <url> (token)`.
  - chell `--daemon` off a TTY no longer spawns a console onto its pipe — a boot ends at a login only where there is a terminal to log in on; otherwise the daemon says so and keeps listening, as the standalone `calypso` binary already did.
  - menu `@fnndsc/menu/logo`: the mise brain and its frame renderer move from the kernel to the wire package, decoding with `atob` and touching no Node builtin, so a browser can draw the same brain a terminal boot does. brasa re-exports it; chell and calypso keep their import.

  Exemplar `14_tokenLogin` starts a daemon this way against a live CUBE, off a TTY, in isolated directories, and proves the Connect row and a live berth.

- 43b9440: The space of everything run here: the wait is drawn with what is known, and UNIVERSE is a face.

  While the job index warms, RUNS-02 had nothing to show but a refusal and a moving figure. Now the session reports each feed as the index reads it — its jobs collapsed by plugin per place in its pipeline (a fan of three hundred conversions is one node of 300), with a status on every node — on the prompt context (`procWarmup.landed`), and the pane draws them as they arrive: every feed its own small DAG, floating free like molecules in a solution, counts as weight and status as hue, feeds of one pipeline shape pulled together by an unseen anchor so the space settles into constellations. Every node is real. When the index is whole the roster takes over, as before.

  `proc universe` answers the same picture from the cache at any time, whole or warming, and says which; the dashboard's UNIVERSE tile opens it on the RUNS canvas. A feed's status words are now the DAG's own (`finishedWithError`, `started`, …) wherever cumin derives them from counts, so a feed on a surface wears the hue its jobs would.

### Patch Changes

- Updated dependencies [8a8dc25]
- Updated dependencies [1bdf876]
- Updated dependencies [5b520c7]
- Updated dependencies [7bba167]
- Updated dependencies [1c169d7]
- Updated dependencies [43b9440]
  - @fnndsc/menu@0.10.0

## 3.22.1

### Patch Changes

- Updated dependencies [9cf2ea2]
- Updated dependencies [d133ef6]
- Updated dependencies [c70e11e]
  - @fnndsc/menu@0.9.0

## 3.22.0

### Minor Changes

- aa923c6: A replayed PACS query no longer costs a round trip per series. Reconciling a stored answer against what CUBE already holds asked about every series in turn, two requests each, and held the whole answer back until the last one replied: a patient's history of 299 series took 20.6 seconds against a live CUBE, so a replay — whose entire purpose is not to trouble the wire — felt exactly like a fresh query. CUBE indexes a stored series by its study, so the reconciliation is now one page per study, with file counts fetched only for the series actually home. The same question costs 3.1 seconds. `seriesStorage_resolveMany` is the new bulk resolver; the per-series resolver stays for the paths that need it and for a study the answer cannot name.

## 3.21.1

### Patch Changes

- Updated dependencies [7c793ad]
- Updated dependencies [af2df66]
  - @fnndsc/menu@0.8.0

## 3.21.0

### Minor Changes

- 711e1b3: The boot's PACS-query row now reports the amount of queries the index holds, not the one record a resume re-touched. The sweep resumes from the newest query it already has with an inclusive `min_creation_date`, so CUBE hands that boundary record back and the loop counted it — a resume that found nothing new still read `Indexed 1 PACS query`. The sweep now counts only records the index did not already hold (new `QueryIndex.has`), carries the total held in its result, and the boot row reads `1905 PACS queries indexed`, adding `, N new` only when the top-up actually filed some.

### Patch Changes

- Updated dependencies [d89e31b]
  - @fnndsc/menu@0.7.0

## 3.20.0

### Minor Changes

- 49634f2: feat(cumin): CUBE pace — every paged list read is timed as it passes through `resource_call`, and `pace_get` reports the median of the last twenty

### Patch Changes

- Updated dependencies [49634f2]
- Updated dependencies [2545ffa]
  - @fnndsc/menu@0.6.0

## 3.19.0

### Minor Changes

- 6cd5ab1: feat(cumin): the feed-load register learns failure — `feedLoad_fail` names where a walk stopped, `feedLoad_of` reads one feed's load, and a failed entry is forgotten after a minute
- 57ba039: feat(cumin): `feedLoads_all` names every feed topology walk in flight, earliest first, with the failures still remembered; `feedTopology_evict` drops a feed's instances, roots and loaded mark while keeping its roster row
- adf8cc1: feat(cumin): `listPages_walkWindowed` — the one pagination loop, windowed: the first page alone to learn the total, then up to N pages in flight, each yielded as it lands; sequential when the server reports no total; a failing page ends the walk once the window settles
- 98ab832: feat(cumin): the process cache annunciates the roster walk in flight (`rosterSync_progress`/`rosterSync_get`, delta or full)

### Patch Changes

- Updated dependencies [6cd5ab1]
- Updated dependencies [57ba039]
- Updated dependencies [98ab832]
  - @fnndsc/menu@0.5.0

## 3.18.0

### Minor Changes

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

- 5a339f0: feat: a plugin is data — the manual becomes a projection of the model

  A plugin's substance existed only as text. `cat /bin/<entry>` fetched the plugin, formatted a manual, and that manual was the whole of what any surface could have — a paragraph nothing downstream can act on: not a card, not a parameter list, not a form, not an export.

  The kernel now builds the model first and renders the manual from it. `plugin info pl-dcm2niix-v2.0.0` answers with a `plugin.info` model carrying identity, the authoring facts, and every declared parameter; `cat /bin/pl-dcm2niix-v2.0.0` prints exactly the text it printed before, now as one projection of that model rather than a second independent scrape that can drift from it.

  **Parameters carry the flag as it is typed.** A plugin's own `flag` when it declares one, `--name` otherwise — a form built from the name alone would spell `--inputFile` where the plugin wants `-i`.

  **The parameter list is drained to exhaustion.** `getPluginParameters({ limit: 100 })` was one of the silent truncations catalogued in #401: a plugin declaring more lost the tail and said nothing about it. `pluginParameters_drain` walks to the end, and a live exemplar checks the model's count against the count CUBE itself reports — a client that both fetches and counts can agree with itself while being wrong.

  cumin gains `plugin_find` and `pluginParameters_drain` on the typed contract, so the `/bin` reader no longer reaches past it to the raw client.

  No surface change: this is the wire fact a plugin's one-node graph will read.

### Patch Changes

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

- Updated dependencies [116e8ba]
- Updated dependencies [7181f7e]
- Updated dependencies [d2a4315]
- Updated dependencies [a245b5f]
- Updated dependencies [5a339f0]
- Updated dependencies [62761a3]
  - @fnndsc/menu@0.4.0

## 3.17.1

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

## 3.17.0

### Minor Changes

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

- f8d1b1c: Index movement is annunciated: a feed's first-visit topology load (`feed 812 indexing: 3400/20000 17%`) and roster arrivals (`+feed 812`, feeds created since or newly shared) reach the prompt context's `procWarmup` segment — `feed`, `arrived`, and `sweeping` so a renderer can tell a sweep from a load — and the chell prompt renders both. The process cache keeps the two registers (`feedLoad_progress/clear/get`, `arrivals_note/recent`); the salsa feed walk and roster syncs feed them.

### Patch Changes

- f73e6c2: fix: a refused read says so, and the header stops wasting the space it takes

  **A file you may list is not always a file you may read.** CUBE lists the contents of a shared feed but refuses the bytes, answering 403 for a file whose size the same identity can see. mise reported that as "not found (404) or access denied (403)" — two opposite answers in one sentence — and the client returns null for a refusal as readily as for an absence, so no status reached the message at all. On the failure path only, the real status is now asked for and reported: a refusal names itself and says what it means.

  **argus swallowed it.** The viewer joined the rendered text of a failed read, which is empty, and drew a blank pane — indistinguishable from an empty file. A refused read now opens as `READ REFUSED` with the session's own words, and the row is remembered: it dims, strikes through, and carries a slashed-circle glyph explaining that it is listed but not readable. This is reactive by necessity, since a listing does not say what may be read.

  **The file browser's frame is not part of its scroll.** The caps and filter strip shared the scrolling box with the rows, so the scrollbar ran the full height of the pane, up behind the frame, and the sticky frame had to paint over whatever passed beneath it — which is what covered the first row's trailing cell. The frame now sits above a scrolling field, so the scrollbar begins at the frame's lower border.

  **The header used one column of two.** The version rows live inside a wrapper, so a two-column grid on the face made that wrapper the single grid item: ten rows stacked in the first track while the second sat empty. The grid moved onto the readout itself. Measured against a live daemon, the band falls from 246px to 199px (19% to 15.3% of viewport), both columns are used, no value wraps or elides, and the attribution is inside the fold instead of clipped.

  **Preview cards take the wheel**, on both axes, with scroll chaining contained, and hold 4000 bytes rather than 600 so there is something behind the gesture.

  **MEDICAL** replaces SICKBAY as the scheme's name and is the scheme a browser that has never chosen one starts in. A remembered `sickbay` choice maps forward rather than being lost.

- aa25502: The process cache records the compute resource each plugin instance ran on (from the CUBE list row), and the `feed.dag` model carries it per node (`mixed` for a group whose members ran on different resources), so a surface can hue a graph by where its work ran.
- 85c6813: The session-state context (working directory, feed, plugin, PACS server) is owned by the process once loaded: its files are written for the next process to restore from, never re-read mid-session. Two daemons of one identity shared a working directory through `cwd.txt`, and a `cd` in one moved the other. Identity (user, URL) still reads from storage; a connect reloads everything.
- Updated dependencies [5dc064e]
- Updated dependencies [73aa61a]
- Updated dependencies [4f034b9]
- Updated dependencies [aa25502]
- Updated dependencies [f8d1b1c]
  - @fnndsc/menu@0.3.0

## 3.16.1

### Patch Changes

- 25c4ebc: Faster daemon entry. A restored `/proc` roster now goes into service on a delta (feeds newer than the highest restored id) instead of a full feed-index walk; the full walk runs behind the listening daemon and reports how many feeds moved while it was away, each refreshing on its next visit (`procRoster_bootSync`; `procRoster_sync` now returns the feeds it brought in or found changed). The rendered `/etc/group` projection lives in the listing cache, so it survives a restart with the listings: past its freshness window it serves at once and re-renders behind itself, and a local membership change still forces a synchronous re-render. The listing checkpoint accepts any JSON payload, not only listings.

## 3.16.0

### Minor Changes

- 7a0f06e: The `/proc` checkpoint is now a directory of per-feed shards (`~/.cache/chell/proc/<identity-key>/roster.json` + `feed-<id>.json`) instead of one file. A mutation to one feed rewrites only that feed's shard, throttled to one write per 30 seconds per shard with the last change never dropped, so a growing 80k-node feed no longer drags the whole index back to disk on every change; a torn write can damage at most one feed, and a shard whose feed left the roster is ignored on restore. Execution metrics observed on a revisit are now checkpointed too (they previously never triggered a save). A legacy v2 single-file checkpoint is read once and migrated into shards; the old file is left in place for this release. Cache change events now say what they touched (`roster`, `feed`, `all`, `lifecycle`).
- c716624: Directory listings survive a restart. The listing cache is checkpointed (identity-keyed file under `~/.cache/chell/vfs/`, throttled writes) and restored at boot with each entry's original timestamp, so a restored listing is exactly as stale as it really is. Stale handling itself is fixed: the listing path used to serve any cached entry regardless of its TTL (a listing never refreshed until eviction or `ls -f`). Now a fresh entry serves as is; a stale one is served at once and revalidated behind itself when a host can carry the refresh (the daemon publishes the fresh `fs.listing` on the ambient bus, marked `fresh`), and is refetched in line at a plain console. `ls` models carry `fresh` per listing; `vfs.listing_get` exposes the listing with its freshness.

### Patch Changes

- 920e0ac: Checkpoint integrity: a snapshot whose topology-loaded feeds are missing from its roster is refused (never overwrite a good checkpoint with an amputated one), and an empty public-feeds walk while public feeds are already known is treated as a failed source — the known feeds are kept and a warning raised — instead of authoritative absence that removed every public feed from the roster.
- cece0dc: `/proc` freshness is now visit-driven. A revisit to `/proc/jobs/feed_N` (or a `feed diagram` re-render) is a delta, not a re-crawl: one feed-row fetch, and only when the job counters moved, a `min_end_date` walk of the nodes created or finished since the last visit plus an `active=true` sweep of the nodes still running. Nodes a dynamic pipeline spawns after the first load now appear on the next visit; previously they were invisible until `proc refresh`. Settled feeds are re-checked at most once per ten minutes, so work appended to a finished feed is still seen. A `/proc/jobs` visit (and `proc feeds` / `proc jobs list`) picks up feeds newer than the highest known id, and walks the whole index once the roster is older than ten minutes, so a feed shared later still appears.
- Updated dependencies [97af423]
  - @fnndsc/menu@0.2.0

## 3.15.1

### Patch Changes

- 44ba77a: Checkpoint schema v2: execution metrics reach existing caches.

  Metrics ride the warmup's list rows — but a v1 checkpoint restores the
  topology and settled feeds never re-page, so an existing cache would never
  backfill `startedAt`/`finishedAt`/`outputBytes`. The schema bump retires v1
  checkpoints: one fresh warmup repopulates with metrics, and the v2
  checkpoint carries them from then on.

## 3.15.0

### Minor Changes

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

## 3.14.0

### Minor Changes

- 386b28c: Walker edge hardening from post-merge review. `ListPage` gains `fetchedCount` so a page whose malformed rows were dropped client-side still advances the walk by what the server served, closing a refetch/early-termination gap in `listPageFlexible_wrap`-backed drains; `pluginPipingsPage_get` exposes the piping list with its pagination signals and the manifest and diagram projections use it (the diagram's `limit: 1000` single-shot now drains fully). A shared `collectionPage_wrap` replaces five hand-copied collection-to-ListPage transcriptions. Salsa's pure PACS folder grammar moves to a dependency-free `pacsGrammar` module exposed as the `./pacs-grammar` subpath, so test mocks forward the real functions instead of maintaining copies.

## 3.13.0

### Minor Changes

- b20fa64: Pagination completion: `listPages_drain` joins `listPages_walk` for callers that need a whole collection, and `ListPage` gains an optional `hasMore` hint so a walk survives servers that cap the requested limit. Cumin's own remaining loops (groups, group members, current-user memberships) now ride the shared walker, the peer-store link follower gains a cycle guard and a reported page cap, and the single-shot `limit: 1000` reads in feed resolution, feed comments, workflow creation, and pipeline manifests now drain every page instead of silently truncating at a guess.

## 3.12.0

### Minor Changes

- b0b478b: PACS payload and path-grammar consolidation. Cumin gains `dicomPayload`, the one home for DICOM query-payload interpretation (tag unwrapping including the DICOM-JSON `{Value: [...]}` form, study and series array location, UID lookups), replacing four diverged private copies. Salsa's `pacsHelpers` becomes the single authority for the PACS folder grammar, adding `folderUID_get`, `queryLabel_extractFromFolder`, and `queryFolderName_build`; the query path a surface builds now always matches the name the listing shows, including the title fallback the old builder lacked. Brasa's `pacsUtils` and `query` builtins consume the shared helpers; `pacs_tagValueExtract` remains as a compatibility alias.
- bb4e06a: One pagination loop for the wire contract: `listPages_walk` joins `ListPage` in cumin's chrisapi contract, owning offset advancement, total latching, and termination for every paginated CUBE read. The six hand-rolled loops in salsa (five in the /proc VFS provider, one in job search) now consume it, so page-walk edge cases have a single tested home.

## 3.11.0

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

- 69b0617: Typed chell API, third tranche: `cp` and `mv` join the facade with their
  existing `fs.cp`/`fs.mv` models. Fixing what their first typed run
  surfaced: file rename was silently broken against current CUBEs (the PUT
  field drifted from `path` to `upload_path`); cumin now sends the current
  field and falls back for older servers.

## 3.10.0

### Minor Changes

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

## 3.9.0

### Minor Changes

- 22db63f: Make PACS pulls observable and recoverable. A new `pacs status <expression | path | queryId>` reports one line per series: a fill bar of files registered in CUBE against the PACS-reported instance count, the derived state, and the in-CUBE `/SERVICES` folder for every landed series; an expression reuses the caller's most recent matching query instead of minting a new record per check. `pull` is now idempotent: series already fully registered in CUBE are skipped before firing, so re-running the same pull fetches exactly the missing series. Retrieve firing gets three attempts with backoff and is bounded to four concurrent creations, replacing the all-at-once stampede that overloaded CUBE and silently lost retrieves. A series whose firing still fails is reported as `FAILED TO FIRE, will not arrive; re-run pull`, distinct from watch-side failures, which now point at `pacs status` since their transfers usually complete server-side anyway. Cumin's status report gains the per-series storage folder (`seriesStorage_resolve`). The failure modes and operator playbook are documented in docs/pacs-pull-recovery.adoc.
- 590a943: Converge the two PACS retrieve watchers onto one engine. pull's battle-tested LONK machinery (bounded, retried firing; stall/timeout/no-activity detection; storage confirmation; refire loop) moves into salsa as the presentation-free `retrieve/watch` module; the `pull` builtin becomes a thin consumer rendering engine events onto its sink, and the PACS VFS provider's `cp` drops its 5-second polling watcher for the same engine, gaining firing retry, LONK push, and the idempotency skip. The convergence surfaced and fixed two latent defects that had made PACS `cp` unusable on real paths: the source parser assumed paths without the `/queries/` segment and rejected every real listing path, and the file downloader only consulted the userfiles collection, so PACS files under `/SERVICES` read as "not found"; it now falls back to the PACS files collection. Supporting dedup: cumin gains `retry_untilValue` (the one bounded-backoff loop) and `seriesStorage_resolve` gains bounded re-probing, replacing the per-package storage-resolver copies; the `_qid:` parser is now shared from salsa.

### Patch Changes

- 66bc932: Add ChELL group membership commands and include current CUBE usernames in the
  live `/etc/group` projection.
- 8ec8a4b: Add explicit, command-scoped CUBE elevation with `sudo <command>`. The active surface collects an administrator identity and hidden password; a temporary CUBE client runs only the nested command, then the normal session is restored. Group membership and plugin registration now suggest a copyable `sudo` rerun after an authorization failure, and plugin registration no longer owns a separate interactive admin prompt.
- d0ac04f: Preserve failure causes and tighten cache contracts. Errors that were replaced by generic messages now carry their real cause: controller and handler creation failures name the underlying error instead of "no ChRIS context", `cat` shows the actual fetch failure, docker command failures surface stderr detail, context-set errors actually print, settings load/save failures are announced instead of silently using defaults or losing changes, unreadable berth and discovery files are named instead of reading as "no daemon", token-file read errors are distinguished from the logged-out state, and resource deletes report why they failed. Every remaining deliberate error absorption now carries a dated adjudication comment. Cache contracts: the PACS provider's decoded-query cache caches settled results only and is size-bounded; the object-context factory gains an eviction hook (`objContext_evict`) for deleted plugin or feed ids; `mv` and `cp` invalidate the whole affected listing subtree; and a new PACS query invalidates the cached `/net/pacs/queries` listing so it appears in the next `ls` immediately.
- 886f09c: Fix stale directory state in long-lived daemons. Folder object contexts are no longer cached in the cumin context factory: folder paths are not stable identities in CUBE (deleting and re-uploading a directory assigns a new folder id), so a group bound at first touch kept serving the dead folder for the life of the process, which in a calypso daemon meant a freshly uploaded directory listed as permanently empty and `ls -f` could not recover it. Plugin and feed contexts keep their stable-id cache. The listing cache gains `cache_invalidateTree`, and `rm` and directory uploads now invalidate the whole affected subtree, so a delete-and-re-upload cycle cannot serve still-fresh nested listings from the old tree. The salsa native provider also distinguishes a missing folder from an empty one: when every sub-listing comes back empty it probes the parent, and a nonexistent path reports "No such file or directory" instead of rendering as an empty directory.
- d0ac04f: BEHAVIOR CHANGE: failures no longer read as empty results. Commands that previously printed nothing and exited 0 when a fetch failed now report the error and exit non-zero, following the codebase's `Result<T>` pattern throughout. Affected surfaces: listing a PACS study or series that does not exist errors instead of showing an empty directory; `store list`/`store search` and `compute list` error when the store or CUBE is unreachable instead of showing no entries; plugin registration no longer defaults to the `host` compute resource when the compute fetch failed; `rm` on a feed fails when running jobs could not be cancelled instead of claiming success; a recursive scan that cannot list a subtree reports the exclusion instead of silently omitting it; batch job-status gaps and disconnected status fetches push visible warnings; the native VFS distinguishes "folder absent" from "could not verify" so probe failures no longer masquerade as missing directories; `cp` fails when path resolution fails rather than proceeding with a guessed path; join-edge resolution retries after a transient failure instead of permanently recording no joins; and the remote client reports invalid daemon messages instead of silently dropping them. Exit codes are now truthful end to end: `ls` reports an error status when any listing fails instead of aggregating failures into success, and `chell -c` derives its exit code from the command's envelopes, so a failed one-shot command exits non-zero even when the builtin did not set an exit code itself.
- 0e92d4d: Persist and reconcile daemon `/proc` checkpoints, fix wildcard listing of
  virtual executables, keep remote admin prompts on their originating surface,
  add a Unix-style `id` builtin for the current CUBE UID/GID projection and group
  memberships, and make versioned-plugin help, parameters, and README output
  compose correctly through terminals, pipes, and redirects.

## 3.8.4

### Patch Changes

- Carry per-node CPU, memory, GPU, and worker controls through the typed CUBE
  Workflow `nodes_info` contract.
- Accept typed plugin-run parameters without a lossy CLI string round trip.

## 3.8.3

### Patch Changes

- Preserve structured feed-creation parameters, including titles containing
  commas, while retaining support for legacy comma-delimited parameters.

## 3.8.2

### Patch Changes

- Carry cold, cached-refresh, and failed `/proc` lifecycle state through the
  CALYPSO prompt contract; reorder p10k segments and render distinct lifecycle
  clues for local and remote surfaces.

## 3.8.1

### Patch Changes

- 6f0833a: Release the coordinated ChELL stack with deterministic `/proc` topology progress, complete visible-feed indexing, safe warm-up query gating, remote one-shot command completion, and refreshed daemon documentation.

## 3.8.0

### Minor Changes

- e630f79: Draw registered CUBE pipelines with `pipeline diagram <id|name>` or the `/bin` shorthand `<pipeline> --diagram`. Bare output uses the same shallow tree machinery as feed diagrams, `--withargs` appends stored non-null plugin defaults, and `--signalflow` emits the same SignalFlow YAML dialect as feeds. `feed diagram <specifier>` is now a shallow alias of `feed tree`; feed graph commands accept IDs, `feed_N`, exact or unambiguous title searches, and infer the feed from the current `feed_N` directory when omitted.

## 3.7.0

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

## 3.6.0

### Minor Changes

- 0d358c5: /proc now caches settled job status. A finished plugin instance
  (`finishedSuccessfully`, `finishedWithError`, `cancelled`) never changes, so its
  status is kept permanently once observed. Consequences:

  - Listing a fully-finished feed under `/proc/jobs` is instant — no status calls.
  - Live status for active feeds is refreshed with a single feed-scoped list call
    (the list response already carries `status`) instead of one detail fetch per node.
  - Reading a settled instance's `status` returns the cached value without an API call.

## 3.5.0

### Minor Changes

- aa81b0a: Add the error stream to the envelope contract and convert the first fs builtins. `CommandEnvelope` gains `renderedErr` (printable stderr text, ANSI permitted), keeping the error stream separate from pipeable data; `envelope_error` accepts it as a third argument; the structured `errors` field is machine-facing and no longer presented by delivery. chell's `OutputSink` gains `err_write` (stdout sink routes to stderr; capture sink passes through uncaptured, matching today's pipe semantics). Builtins converted: `cd`, `mkdir`, `touch` (models `fs.cwd`, `fs.mkdir`, `fs.touch`), rendered and error-stream bytes identical to the previous behavior.
- 2099ff6: Make the error stack async-context aware and drain it per command. cumin's `errorStack` gains `scope_run` (run work against an isolated stack), `checkpoint_mark`, and `checkpoint_drain`: fire-and-forget background work (topology warm-up, background cache refresh) now runs inside its own scope so its error traffic cannot land in a concurrent foreground command's drain window. chell's dispatch checkpoints the stack before each command and drains anything pushed above the checkpoint into the envelope's `errors` field, escalating status to `error` when a genuine error was left on the stack — a reliable per-command failure signal that also retires the exit-code-delta status heuristic's blind spot (a later failing batch segment no longer reads `ok`). CLI behavior is byte-identical.
- c47ff22: Add the command result envelope (`CommandEnvelope`, `EnvelopeModel`, `ResolutionTrace`, `envelope_ok`, `envelope_error`, `envelope_isOk`): the typed container in which a command's outcome travels from execution to its host, carrying rendered terminal text alongside an optional kind-tagged model, drained error detail, and an optional intent-resolution trace. See docs/calypso.adoc for the governing design.

## 3.4.0

### Minor Changes

- The typed payload extractors (`listData_get`, `itemData_get`, `items_get`) and common chrisapi types (`PluginInstance`, `Feed`, `FileBrowserFolder`, ...) are re-exported from the package index. The `chrisConnection` singleton is now initialized in place instead of reassigned, fixing stale named-import bindings in ESM consumers.

## 3.3.0

### Minor Changes

- Route all chrisapi access through a single adapter seam (`src/chrisapi/adapter.ts`). The public API is unchanged; responses whose `data` payload is missing now surface as errors instead of propagating `undefined`. Enforced repo-wide by a new `lint:seam` CI check.
