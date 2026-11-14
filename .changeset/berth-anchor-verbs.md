---
"@fnndsc/brasa": minor
---

In a berth, `berth anchor <path>` downloads any ChRIS path you can read into the berth's anchors folder. `berth` lists the anchors with their ChRIS path, their node or none, their files and size, when each was anchored and when the berth last closed; `berth drop <name>` removes one and `berth clear` removes them all and empties the outgoing folder, asking first when it holds files not yet closed. A path under your own feeds has the node it runs through, which must be `finishedSuccessfully`; any other path has none. The size and the free space are said before the download, above 10 GB it asks (`--yes` answers), and what does not fit is refused. The files are downloaded without write permission, and `--refresh` downloads an anchor again. On a host, not in a berth, `berth` says so. `help anchors` holds the rules.
