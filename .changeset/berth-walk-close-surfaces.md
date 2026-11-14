---
"@fnndsc/brasa": patch
---

A `berth close` typed at an attached chell no longer counts that chell as work still running in the berth.

Attached `chell --remote` surfaces, and the shells they start directly, are the session's own, as the console's terminals are; what runs under such a shell is still listed. A running-process question nobody can answer is a no: the close says why, names `--force`, and closes nothing.
