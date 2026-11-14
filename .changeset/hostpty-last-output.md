---
'@fnndsc/calypso': patch
---

A program run with `!` on a terminal keeps its last line of output, which arrived after its exit and was dropped.

The daemon's host pty went on relaying output until the pty was quiet for a moment after the exit, with a ceiling of half a second, before it ended the line.
