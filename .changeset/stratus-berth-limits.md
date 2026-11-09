---
"@fnndsc/stratus": minor
"@fnndsc/menu": minor
---

Each berth's CPU and memory limits are set at deploy, with `--berth-cpus` and `--berth-memory`. The berth launcher restarts when they change. The berth capacity rule (the host less the profile's floor, divided by one berth's limits) moves to menu, shared by porter and ARGUS, and `chris status` carries a ChRIS's berths and their limits.
