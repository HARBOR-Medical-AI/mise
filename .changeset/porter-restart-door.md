---
"@fnndsc/porter": patch
---

A stratus session restarted from the browser keeps its door, so it can still be raised to MANAGE.

RESTART relaunched a stratus session without the door porter names at login (the CUBE and the user the password is checked against), so the new session was READ with no way up: TEAR DOWN · REFUSED, "this daemon has no door to check a password at". The restart now passes the same door the login does.
