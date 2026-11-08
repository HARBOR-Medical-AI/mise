---
"@fnndsc/porter": patch
---

A berth can reach a CUBE published on its own host by the name porter uses, through `BERTH_CUBE_HOST`. Set to CUBE's name, the launcher reads cube-net's gateway and gives every berth that name as a host line at it; a cube-net with no gateway refuses to start the berth, saying so. Unset, a berth resolves CUBE by public DNS as before.

The launcher also joins a porter made again back to the wires of berths already running, removes a socket an earlier run left before it starts, and removes the volumes it made when it could not give them to the person, so the next start gives them anew.
