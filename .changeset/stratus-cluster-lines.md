---
"@fnndsc/stratus": minor
---

A cluster script replays: `cluster new` on a kept cluster compares, and `play --status` reads the cluster lines.

`cluster new <name>` on a cluster already kept reads unchanged, or rewrites the spec and says what changed (the kept spec as its base; the zone and the compartment are the cluster's for life and another is refused). `play --status` reads `cluster new`, `plan`, `build` and `verify` from the record: not yet, ready, done or changed, and the build or plan task running now (docs/stratus.adoc, D17; infra's `chrisproject/harbor.mise`).
