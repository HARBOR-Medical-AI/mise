---
"@fnndsc/stratus": patch
---

The VMs and networks the tenancy runs are listed, not only those this session keeps.

A session entered through porter keeps its own records, so the store VM built from another session read "no VMs" while it ran and served cube.chrisproject.org. The tenancy is now the truth: `vm status` lists every instance the tenancy runs outside a cluster (found in one Resource Search, then each holding compartment read for shape, size and addresses), named by stratus's tag or else the cloud's name, and a tagged VM whose data stands without a machine; `net status` lists the networks carrying stratus's tag. A VM this session keeps no record of reads as found (`vm <name>` shows it), and `vm new` refuses its name, since declaring it here would build a second machine beside it.
