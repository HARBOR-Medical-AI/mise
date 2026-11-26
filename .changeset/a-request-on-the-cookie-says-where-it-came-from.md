---
"@fnndsc/porter": minor
"@fnndsc/calypso": minor
"@fnndsc/chell": patch
"@fnndsc/argus": patch
"@fnndsc/stratus": patch
---

A page somewhere else can no longer act on your session through your browser, and passwords can be tried only so often. A browser sends the door's cookie with any request to the door, whoever wrote the page that made it; porter acted on that cookie alone. It now takes a request that changes something on the cookie, a login by password, and the upgrade that opens a session's wire only when the request's `Origin` is the door's own, and answers 403 otherwise, saying what it answers as. A program with a door token and no cookie is not asked.

**A porter behind a reverse proxy must be told its public address**: set `PORTER_PUBLIC_ORIGIN` to what browsers type (`https://porter.example.org`; several are comma-separated). Unset, the door answers only as `http://127.0.0.1:<port>` and `http://localhost:<port>`, and every login made through the proxy is refused with a line that says so. porter prints the origins it answers as when it starts. `chris deploy` with a porter writes the setting itself.

calypso asks the same of an attach: no `Origin` (a program), the daemon's own page, or an origin named in `CALYPSO_ORIGINS` (a development server on another port). A download is stopped by `POST`; a `GET` of the stop address is answered 405. ARGUS sends the `POST`.

chell says the door's origin on its password logins and on the wire, so an older chell is refused by a newer door at a password login and at attach: upgrade chell with the door. A login with a door token is not affected at the login, and is at the attach.

Failed password logins are counted: ten a minute from one address and five a minute against one name, taken up before CUBE is asked; past that the door answers 429 with `Retry-After`. Device codes: ten a minute per address.
