---
"@fnndsc/cumin": patch
---

A PACS file gets ten minutes to arrive, where the CUBE client's default of 30 s failed X-rays over about 9 MB.

CUBE's client offers a PACS file only whole, with no stream. `pacsFile_getBlob` asks for it with `PACS_FILE_FETCH_MS` (ten minutes), which holds a 180 MB file on a CUBE that sends at 0.3 MB/s.
