---
"@fnndsc/cumin": patch
"@fnndsc/salsa": patch
---

A save that fails part way no longer loses the file: the old content stays until the new content is seen in its place.

Rewriting a file removed it and then created it again, two requests, and a failure of the second left nothing at the name. Now the new content is stored beside the old under a staging name, the old file is moved aside, the new one is moved onto the name, and only then is the old one deleted. Each step acts on a file by its id; after a move that reports an error the file is looked up before anything is undone, since the move may have happened; nothing is moved onto a path that is not proved free; and where it is not known which file is where, nothing is removed and the error names the paths. cumin gains `file_uploadReceipted`, which answers the stored file's id and path, and `file_locate`, which answers where a file is by its id. Whether a write is a first write or a rewrite is decided on proof of what holds the path: a folder listing that failed or was cut short stops the write, and so does a folder, a link or more than one holder at the name. A file is moved or deleted by its id only once it has been seen at the path it was put at, so one that another writer has since moved is left alone. And cumin's `file_moveById` tries the older rename field only after CUBE refused the newer one outright (HTTP 400), never after a reply that was lost.
