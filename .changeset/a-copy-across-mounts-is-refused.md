---
"@fnndsc/fond": patch
"@fnndsc/salsa": patch
---

A copy from one mount to another is now refused unless that pair is offered, instead of landing where nobody asked.

The dispatcher handed a copy to the mount that owns the source with both paths, and that mount treated the destination as its own: a copy out of a scripts folder into a CUBE folder was written into the scripts folder's own disk, and a copy onto a `/proc` or `/etc` name was sent to CUBE as a file path. Now who owns each path is settled before either mount is asked anything, and again once the paths are resolved. Within one mount a copy is as it was. Across mounts it is made only out of a mount that declares `copiesOut` into CUBE's own tree, which is the PACS pull into a feed's folder; every other pair, and a folder that only holds mounts on either side, answers `EXDEV`.
