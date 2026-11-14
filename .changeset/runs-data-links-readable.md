---
'@fnndsc/fond': patch
'@fnndsc/salsa': patch
'@fnndsc/brasa': patch
---

A file in a run's output opens from RUNS through a link, as every pl-dircopy output holds: it reads where it is stored.

A path under a node's `data` in `/proc/jobs` that passes through a `.chrislink` was read at the feed path with the link unfollowed, so CUBE found no folder (`Failed to initialize ChRIS context for files`) while `ls` of the same folder listed the file. Every reader and lister now asks one resolver, `storePath_resolve` in brasa, where a path is stored: `~` and relative paths, a mount's own answer (`/proc/jobs/…/data` is the job's output folder, through fond's new `VFSProvider.storePath_resolve`), and the store's links at any depth, in turn. `cat`, `wc` and the other text filters, `ls` and the listings ARGUS draws, the `/vfs` byte route, `download`, `cp`, wildcards, `dcm` and the berth's reads go through it, and the per-command copies of the `/proc` mapping and the link walk (`file_read`'s, `download`'s and `dcm`'s, and the berth's link walk) are gone. `cp` out of a node's data, refused before as a read-only file system, copies.
