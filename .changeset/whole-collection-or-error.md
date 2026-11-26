---
"@fnndsc/cumin": patch
"@fnndsc/salsa": patch
---

A folder is not taken for empty on a listing that came back malformed, short, or with rows that say too little.

Removing a folder asks first what holds its path and whether it holds anything, and a wrong "nothing" there deletes. cumin gains a strict walk of a collection, `resources_getWhole`, which follows the server's word on whether more follows and refuses a page that is not a list or carries no items; salsa's `files_listWhole` and the proofs in `files/proof` use it. A row with no name, or one of the name asked about with no usable id, now ends the proof with the reason. A folder or file whose own name ends in `.chrislink` is found under that name; only a link has the suffix read as CUBE's mark.
