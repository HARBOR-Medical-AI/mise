---
"@fnndsc/stratus": minor
---

A ChRIS with a porter can give each person's session a berth of their own, set by `chris deploy --berths on|off`. The deploy reads the group that owns Docker's socket and gives it to the launcher alone, a service on no network that answers porter on a unix socket in `berth/run/` with a secret both read from a 0600 file the image's `node` user owns. It reads the berth image porter's release pins, pulls it by digest before anything waits on it, waits for the launcher's health, and records `berths` and `berthImage` on the VM. Turning berths on or off is a change in the plan and restarts porter, ending its open sessions. Each berth reaches CUBE by its public name at cube-net's gateway. `--berths on` is refused while the porter this stratus pins (0.9.13) predates the launcher, and without `--porter`.
