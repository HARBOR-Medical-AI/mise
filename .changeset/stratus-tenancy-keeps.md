---
"@fnndsc/stratus": minor
---

Every session on every host now sees and manages the same VMs. The tenancy keeps each VM's SSH key and ChRIS passwords; a host's records are only a cache. A VM's secrets go into one vault per region in the tenancy (`mise`), written before its machine is built, after each `chris deploy`, and by the new `vm keep <name>` for a VM built before. `vm status` fills and corrects this host's cache from the tenancy, so a VM built from a terminal reads whole from a porter session, and one resized or torn down elsewhere is read again.
