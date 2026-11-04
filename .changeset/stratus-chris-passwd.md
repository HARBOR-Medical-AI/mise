---
"@fnndsc/stratus": minor
---

A password on a ChRIS stratus deployed can be changed, with `chris passwd [<user>] [--on <vm>]`. The admin's (`chris`, the default) changes on the host, in `cube.env` on the VM and in CUBE together: CUBE sets `chris`'s password from `cube.env` at every start, so a change made in CUBE alone does not last. The operator is asked first, since CUBE starts again and is down for a minute or so; the new password is typed twice (empty: generated and shown once), checked by signing in, and kept in the tenancy. A run stopped part way finishes when asked again with the same password. Any other account's password is set in CUBE alone and never kept.
