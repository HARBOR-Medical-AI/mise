---
"@fnndsc/salsa": minor
"@fnndsc/brasa": minor
"@fnndsc/chell": minor
"@fnndsc/cumin": minor
"@fnndsc/menu": minor
"@fnndsc/chili": minor
---

A CUBE fills itself from the plugin index in git, with a plan and one question; descriptors are checked before upload.

`plugin sync [source]` reads FNNDSC/chris-plugins (or another index: a GitHub repository at a ref, a directory or `.tar.gz` in CUBE, or a host path), compares it with the connected CUBE and shows the plan — add, add beside an older version, skip, and the reports (newer here, a different descriptor, an image under another version, here but not in the index, a descriptor that fails the checks) — then asks once and uploads four at a time; it never deletes or changes a plugin already there, `--plan` stops at the plan, `--ref` pins the index, and a non-administrator sees the plan and the `sudo` line. `plugin validate` checks descriptors without a CUBE: the index's schema, CUBE's upload rules, the file name, case clashes and every image on its registry (`--offline` skips the last and says so). `plugin index` shows or sets the index sync reads. `plugin add` takes `--json <file>`, and a plugin URL in another CUBE is passed to CUBE's upload; every refusal carries CUBE's own reason. `plugin add` now lives in salsa and brasa: chili's `plugins add` hands its words to salsa, and chili's docker helpers are gone.
