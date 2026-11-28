---
"@fnndsc/fond": minor
"@fnndsc/brasa": patch
"@fnndsc/chell": patch
---

An edit, and a config document on its way to ChRIS, are written to a private copy nobody else on the machine can read.

How: `edit`, `config write` and chell's local editor wrote their temporary files at predictable names in the shared temporary folder, readable by other accounts and followed through a link planted there. Each is now a file created anew (0600) in a folder of its own (`mkdtemp`, 0700), through fond's `privateTemp_write`; a suffix a daemon asks for is kept only when it is a plain one (`suffix_safe`). A failed `edit` save still keeps its copy and says where; every other way out removes it.
