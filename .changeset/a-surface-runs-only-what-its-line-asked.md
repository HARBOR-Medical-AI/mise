---
"@fnndsc/menu": minor
"@fnndsc/calypso": minor
"@fnndsc/brasa": minor
"@fnndsc/chell": minor
---

A chell attached to a session runs a host command, pipeline segment or editor only when the line it sent asked for it. Each `shell`, `pipe` and `edit` request now names the asking line (`lineId`, the surface's own id), and chell runs it only against what that line asked for, read before it was sent by the engine's own routing (`lineHostOperations_read` in brasa): a `!` line its command, a later pipeline segment that is not a builtin exactly as typed, grep's and `command`'s delegated host lines, an `edit <file>` line one edit of that file. Each grant is spent once and retired with the line, a cancel or the connection's close. A request with no line, for another line or connection, or for anything else runs nothing and says why. Lines chell cannot read that from (lists, captures, redirects, background lines, references or patterns the session expands) ask for nothing here. A delivered file must also be one a source the line named would send (the file by its name, a named folder's files by their path inside it), once per line. The daemon refuses at its own side a host command or pipeline segment for a line another surface sent (a browser holding a terminal's line). A session of an earlier release sends no line id, so a current chell runs nothing for it until the daemon is upgraded.
