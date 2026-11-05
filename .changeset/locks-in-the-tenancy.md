---
"@fnndsc/stratus": minor
"@fnndsc/menu": minor
"@fnndsc/argus": minor
---

A VM's or a cluster's lock is kept in the tenancy, so a lock set on one host holds on every host. It carries when it was set, and stops a teardown from another host. `vm protect` and `cluster protect` write it to the vault from a MANAGE session (a READ session sets it on its host only and says so); every listing reads it back, and a teardown reads it again before it acts. `vm status` and the cluster summary carry `lock {at, kept}`; the VM and TD screens say where the lock is kept and when it was set, and in a READ session declaring a VM and setting a lock raise to MANAGE first.
