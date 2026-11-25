---
"@fnndsc/cumin": patch
"@fnndsc/salsa": patch
---

A save that fails part way no longer loses the file: the old content stays until the new content is seen in its place.

Rewriting a file removed it and then created it again, two requests, and a failure of the second left nothing at the name. Now the new content is stored beside the old under a staging name, the old file is moved aside, the new one is moved onto the name, and only then is the old one deleted. Each step acts on a file by its id; after a move that reports an error the file is looked up before anything is undone, since the move may have happened; nothing is moved onto a path that is not proved free; and where it is not known which file is where, nothing is removed and the error names the paths. cumin gains `file_uploadReceipted`, which answers the stored file's id and path, and `file_locate`, which answers where a file is by its id.
