---
"@fnndsc/calypso": patch
"@fnndsc/chell": patch
---

A daemon hands its attach token to the shells it starts in their environment, never on their command line. A command line is shown to every user of the host by `ps`; calypso's console and its browser terminals started chell with `--token <token>`. They now set `CHELL_ATTACH_TOKEN`, which chell reads when no `--token` is typed and removes from its environment at once, so nothing it starts inherits it. `--token` still works for a person attaching by hand.
