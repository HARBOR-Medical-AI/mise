---
"@fnndsc/brasa": minor
---

A `/bin` run given files from two feed nodes now refuses, naming both nodes, instead of merging them into a new feed. Files of a node beside files outside the feeds tree refuse the same way; nothing is staged and no feed is made. A word such as `sub=01.nii` that reads as an assignment but names a file that exists refuses with the spelling to use: `write ./sub=01.nii for the file`.
