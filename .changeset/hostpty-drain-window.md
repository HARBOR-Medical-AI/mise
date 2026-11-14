---
'@fnndsc/calypso': patch
---

A program run with `!` on a terminal keeps its last output on a busy host, where it can arrive well after the program exits.

The host pty waits for 150 ms of quiet after the exit (at most 2 s) before it ends the line; 40 ms was too short on a loaded machine.
