---
"@fnndsc/brasa": minor
---

A wildcard now expands in any part of a path, and a `/bin` line naming several directories runs once for each. `Mriconvert ~/uploads/sub-*` and `pl-x ~/feeds/feed_*/pl-dircopy_*/data` expand to every match, sorted, and each directory is its own run: outside the feeds tree it roots its own feed, inside it attaches at its node. Every operand is checked before any run starts, so one bad operand refuses the whole line; all runs are dispatched, then one wait holds the line for them all. A pattern matching nothing refuses as `<pattern>: no match`. To an fs plugin several directories are its one `dir`.
