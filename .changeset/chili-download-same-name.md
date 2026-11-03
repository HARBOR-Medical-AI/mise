---
"@fnndsc/chili": patch
---

Downloading two sources that share a name keeps both, each under its parent's name, and says so.

`download a/data b/data <dir>` kept the first `data` and dropped the second without a word (#1364). Sources whose basenames collide now land as `<parent>/<name>` under the destination, and the notice channel names what was kept where.
