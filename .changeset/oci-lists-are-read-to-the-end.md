---
"@fnndsc/stratus": patch
---

A zone, compartment, tag namespace, vault, key or secret on a later page of the cloud's answer is now found.

Ten OCI list calls in the build and the keep read only the first page of the answer, so a thing on the second was taken as not there: a compartment could be made twice, a vault or a key made beside the one already kept, and a bucket's links left behind so the bucket could not be removed. Each call now follows the next-page token to the end, through `pages_drain`, which moves to its own module.
