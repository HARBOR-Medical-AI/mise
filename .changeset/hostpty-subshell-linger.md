---
'@fnndsc/calypso': patch
---

A program run with `!` on a terminal keeps its last output on any machine, however loaded.

The command runs in a subshell and the pty's shell lingers 0.2 s before it exits with the command's status, so node-pty reads the program's last bytes before the pty closes; an `exit` in the command ends only its subshell.
