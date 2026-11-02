---
"@fnndsc/brasa": patch
---

A script's status says, after a line's state, the task running it now and the `wait` that follows it.

`play --status` carries the task's path in its model as `running` (docs/stratus.adoc, D17).

A follow of a task asked to stop before it began (a STOP between a question's answer and the job's start) ends at once instead of running to the task's end.
