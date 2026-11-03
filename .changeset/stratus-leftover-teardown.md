---
"@fnndsc/stratus": patch
---

Tearing down a cluster torn down before, but still tagged in the tenancy, removes what is left.

An earlier teardown could leave a cluster's empty stack, its image bucket and its compartment behind (quay, 2026-10-25), so the tenancy search kept finding it as GONE and the dashboard kept listing it. The record is rewritten to what the tenancy still holds, the line asks for the name typed back, and the leftovers go; with nothing of it left in the tenancy the answer says so.
