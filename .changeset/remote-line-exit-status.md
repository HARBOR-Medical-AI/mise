---
"@fnndsc/menu": patch
"@fnndsc/calypso": patch
"@fnndsc/chell": patch
---

A `chell --remote … -c` line now exits with the status it ended with on the daemon, not only 1 for an error answer.

The daemon's `result` message carries the line's `exitCode` (the status `$?` holds there), so a command that answers ok but ends with a status of its own, such as `berth close` that closed nothing, exits 1 through a door as it does run in place. With `-e` a segment ending with any status other than 0 stops the line. A daemon that sends no status is read as before.
