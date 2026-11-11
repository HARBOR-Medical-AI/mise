---
"@fnndsc/brasa": minor
---

`&&` and `||` now join commands on a line as they do in `sh`. `a && b` runs `b` only when `a` succeeded, `a || b` only when it failed; before, `cd ~/uploads && pwd` was read as a `cd` into a folder named `~/uploads && pwd`. Inside quotes each is text, a skipped command leaves the outcome as it was, and `;` starts afresh. `help pipes` says so.
