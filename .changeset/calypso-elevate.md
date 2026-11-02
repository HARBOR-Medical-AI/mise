---
"@fnndsc/calypso": minor
---

A surface can raise its session from READ to MANAGE with the person's password, checked at its door.

`elevate` on the wire carries the password once; the daemon checks it at the CUBE named in `CALYPSO_ELEVATION_URL` for `CALYPSO_ELEVATION_USER` and grants the `tasks` tier to that surface alone, for as long as it is attached, a terminal's lines acting as its owning browser's. The attach says whether a door stands (`elevation`); a daemon started without one refuses by name (docs/stratus.adoc, D14).
