---
"@fnndsc/stratus": minor
"@fnndsc/menu": minor
---

Each berth's CPU and memory limits are set at deploy, with `--berth-cpus` and `--berth-memory`. The berth launcher restarts when they change. The berth capacity rule (the host's memory less the profile's floor, divided by one berth's memory; a berth's CPUs are a cap on shared CPUs, not counted) moves to menu, shared by porter and ARGUS, and `chris status` carries a ChRIS's berths and their limits. A deploy refuses a berth memory the machine cannot hold above the profile's floor and `--berth-cpus` above its vCPUs, and restarts the launcher by the policy file on the machine rather than the record.
