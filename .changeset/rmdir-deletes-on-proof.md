---
"@fnndsc/salsa": patch
---

A folder is removed only when proved empty: one whose files could not be read is no longer deleted with them.

A listing keeps the rows it has when part of it fails, which is right for showing a folder. `rmdir` took those rows as the whole answer, so a folder whose files CUBE refused to list, while its subfolders and links read as empty, was deleted with everything in it. Now every listing of the folder must answer in full and hold nothing, and the parent's listings must show that a folder, and only a folder, holds the path; a listing refused, cut short at its bound, or not made at all ends the removal with the reason. The proofs are `pathHolders_prove` and `folderEmptiness_prove`.
