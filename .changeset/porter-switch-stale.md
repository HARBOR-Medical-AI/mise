---
"@fnndsc/porter": patch
---

A switch to the cloud session restarts a stratus daemon left up on an older release, on the tier it had.

The login already restarted a stale ChRIS session; the switch joined a stale stratus one, so a person who logged out and in after a deploy still talked to the old kernel until they pressed RESTART.
