---
"@fnndsc/stratus": patch
---

A script's status names the task running a line now, so a surface can follow a build instead of holding it.

`play --status` reads it for a `net build`, `vm build` or `chris deploy` whose job runs under `/proc/steps/`, and for a `chris user add` whose add job names its user (docs/stratus.adoc, D17).
