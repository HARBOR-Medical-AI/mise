---
"@fnndsc/stratus": minor
---

A VM's declaration is kept in the tenancy, and `vm status` says what runs, read from the cloud, beside what is declared.

From a session with the tasks tier, `vm new` keeps the declaration in the VM's vault secret with when it was made, and `vm build` keeps it before it plans; a READ session keeps it on its host and says so. Every keep merges with the vault's (a host lacking the VM's key or ChRIS never drops them; the newer declaration wins), and each listing takes a newer declaration from the vault. Each listing also reads the instance's vCPUs and memory and the boot and data volumes' sizes, with when (`stands`), and a build line's standing compares the declaration with what runs (`declared, not built: disk 50 → 180 GB`). Under `stratus --fake` the fake tenancy lists the volumes its builder made.
