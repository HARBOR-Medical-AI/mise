---
"@fnndsc/stratus": minor
"@fnndsc/menu": minor
---

A ChRIS's status reads each person's berth through porter, with the admin's credentials, beside the accounts. A berth is running with its CPU and memory, or stopped with the home kept; when porter cannot say, the status says why (an older porter names its version). A porter that starts no berths has answered, and the status says berths are off rather than not read. The live read carries `berths`, `berthsWhy` and `berthsOff`, all optional in the menu schema, so an older daemon and a newer ARGUS work together either way.
