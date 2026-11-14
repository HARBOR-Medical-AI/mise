---
"@fnndsc/chell": patch
---

A chell that needs a password while its input is closed now says so and exits 1, instead of ending silently with 0.

`chell <user>@<url> --daemon` (or any login that asks) with standard input closed fails with "no password for <user>@<url> (no input to answer the question: standard input is closed)" and names `--saved-token`, `--auth-token-stdin` and `-p`.
