---
"@fnndsc/brasa": patch
---

A folder downloads, uploads or anchors 8 files at a time, and `-j N` says how many (1 is one at a time).

`-j N` / `--jobs N` (1 to 32; 1 is one at a time; a larger number is refused by the parser) is declared on `download`, `upload` and `berth anchor`, and the session variable `TRANSFER_JOBS` stands in when a line gives none, refused in a plain line when it is not a whole number from 1 to 32. A file that fails is tried once more, then named in the summary; the rest continue and the line's exit status is 1, where a `download` with failures used to end 0. Ctrl-C or a job's stop starts no more files and stops those in flight. An anchor stays whole: one with a file that fails again is named with its reason and nothing is anchored.
