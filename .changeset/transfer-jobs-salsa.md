---
"@fnndsc/salsa": patch
---

A folder download lists its folder once, not once for every file in it.

A CUBE file is read by an id its folder's listing gives, and `pathFileId_resolve` listed the whole folder for each file, so a folder of N files cost N listings of N rows. Inside `fileIds_memoRun(operation)` each folder is listed once and shared by every read in it, in flight together or not; a folder that cannot be listed is listed again. Outside it nothing is kept, so a read after an edit lists afresh. `download` and `berth anchor` run their transfers inside it.
