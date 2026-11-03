---
"@fnndsc/stratus": patch
---

A teardown is seen running: its condition, its task to follow, and the Resource Manager log streaming as it goes.

The operator tore harbor down and saw nothing for the quarter hour the destroy took. Three causes. The Resource Manager log was read paged, and that read answers `invalid pagination token` a few thousand lines in, on every ten-second poll, so no line of the destroy was ever passed on (the read was forgiven, not shown); the log is now read as one text. The cluster's state only ever looked for the build's task, so a teardown was never `running` and the condition never moved; the state now carries the teardown's task (`/proc/steps/<name>-teardown`, step `teardown`) and the condition TEARING DOWN, and `cluster teardown` shows the state as the task starts and as it ends (GONE), so a surface watching redraws without asking.
