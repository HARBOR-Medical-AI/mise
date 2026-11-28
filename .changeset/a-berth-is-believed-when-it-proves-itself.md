---
"@fnndsc/fond": minor
"@fnndsc/calypso": minor
"@fnndsc/chell": patch
"@fnndsc/porter": patch
---

A session's berth sits in a folder only its owner can use, and counts only when its daemon proves it wrote it. Without a runtime directory the folder is `<tmpdir>/calypso-<uid>`; folders and records are held to this account (no link, no other owner, nothing wider than 0700/0600) and written by rename, never through a planted link. Each launch writes a probe key into its record and answers `GET /instance?nonce=` with an HMAC proof over its identity, pid and boot time, so the attach token never goes to an address that merely accepts a connection. A daemon of an earlier release cannot prove itself: it is listed as unverified, and neither chell, calypso nor porter starts or adopts beside it. Stop such a daemon once (Ctrl-C at its idle prompt, or its service manager) and start it again. No process removes a berth or the attach note; the next daemon replaces them. The unused `discovery_*` exports are removed, along with `berth_remove`, `berthUrl_isAlive` and chell's `berth_probeLive`.
