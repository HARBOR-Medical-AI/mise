---
"@fnndsc/porter": patch
---

A berth now knows which image it runs, so `berth close` records it in `berth.json`.

The launcher sets `MISE_BERTH_IMAGE` on each berth it makes: the tag it runs with the digest the host holds for it (`…/mise-berth:latest@sha256:…`), or the tag alone when the engine names no digest. A berth already running keeps no such name until it is made again.
