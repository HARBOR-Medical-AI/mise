---
"@fnndsc/porter": minor
---

A logout, a switch, or a cookie's hour now ends that browser's cookie for good, and closes what it had open.

How: a door cookie used to be the session key signed, with nothing the door kept, so a copied cookie worked after logout and across restarts. It now names a grant the door keeps (`door-grants.json`): made by a login or switch that succeeds, ended by the browser's logout, by a switch away, or at `PORTER_COOKIE_HOURS`. The connections opened under a grant are closed when it ends, at its hour even with no traffic: a relayed WebSocket gets close code 4401 at a frame boundary, a boot stream ends. A switch moves the grant in one step, so a logout meanwhile wins. A login whose grant cannot be kept answers 503 and sets no cookie, and a login that fails costs no standing named token. A logout refuses its cookie at once (input on its open wire stops then too); a logout that cannot be written answers 503 and may be asked again. Every browser signs in once after the upgrade.
