---
"@fnndsc/brasa": patch
---

A folder downloaded in the browser arrives named after the folder, not as `parent.zip`.

The zip pipeline names its file after the folder above the one archived, so every folder downloaded through ARGUS was saved as `parent.zip`. `download` now hands the surface the folder's own name with the archive's extension (`series.zip`); the archive in CUBE keeps the name the pipeline gave it.
