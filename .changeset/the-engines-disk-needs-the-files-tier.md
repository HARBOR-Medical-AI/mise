---
"@fnndsc/brasa": minor
"@fnndsc/fond": patch
"@fnndsc/salsa": patch
"@fnndsc/stratus": minor
"@fnndsc/chell": patch
---

A session reads or writes its host's disk only when started with the files tier of host control. Under a daemon without `--host-control=files`, these are refused by name where they used to act on the daemon's disk: `>` and `>>` (refused before the command runs), `play` of a manifest that is not one of the session's own files, `touch --withContentsFromFile`, `plugin sync`, `plugin validate` and `plugin add --json` on a host path, chili's `path upload`, `path download`, `chefs upload` and `files create --from-file`, and stratus's `--admin-password-file` and `--password-file`. A local shell is unchanged: its disk is its operator's. `play` now tells three things apart: a manifest that is not there, one the session's files refused or could not serve (said as that, with the disk not looked at behind it), and one beside the engine that the tier does not allow. In stratus, a script in the library (`/scripts/...`) plays with no tier; a path in a checkout on the daemon's host needs it.
