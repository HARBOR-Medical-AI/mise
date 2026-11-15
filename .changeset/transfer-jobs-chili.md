---
"@fnndsc/chili": patch
---

Folder downloads and uploads move their files through cumin's transfer pool, 8 at a time unless told otherwise.

`files_downloadWithProgress`, `files_downloadManyWithProgress` and `files_uploadWithProgress` take `jobs` and `signal`; their summaries carry `failedPaths` (each file that failed after its retry) and `cancelledCount`. Progress still counts files as each one ends, in whatever order. An upload CUBE refuses fails with the reason the upload noted, rather than `Failed to upload`.
