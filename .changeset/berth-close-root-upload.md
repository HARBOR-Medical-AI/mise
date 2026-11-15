---
"@fnndsc/brasa": patch
---

A berth close that makes a new feed makes one node over your work alone, and `jobs inspect <id>` shows that job again.

`berth close` with no anchor under your feeds, or with `--newfeed`, starts the feed with `pl-dircopy --dir ~/berth/<uuid>` as its root and only node; the anchored paths are named in `berth.json` (`placement.inputs`) and no longer copied into the feed, since pfcon staged a root over them into the work's input before its job started, which copied every anchor and could cancel the close. A close into a feed (every anchor under one node, or `--infeed`) is `pl-dsdircopy` under that node as before; `berth.json`'s `attached` drops `root`. `inspect` on `jobs`, `feed`, `tag`, `pluginmeta`, `workflow` and `compute` takes an optional id and shows that record's fields with their values; with none it names the fields, as before.
