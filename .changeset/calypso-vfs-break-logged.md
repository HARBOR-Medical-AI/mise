---
"@fnndsc/calypso": patch
---

A file whose bytes stop coming from CUBE is one line in the daemon's log. The line names the path, the bytes sent of the size CUBE stated, the milliseconds and the cause with its code. The `/vfs` status waits for CUBE's first byte, so a file that never starts is a 502 saying `the file did not arrive from CUBE: <cause>`; a break after bytes have gone cuts the socket, which the porter and the browser see as a body that stopped.
