---
"@fnndsc/stratus": minor
---

A ChRIS that stratus deployed is filled from the plugin index with `chris plugin sync --on <vm>`, run by its own chell.

The plan is read on the VM first and asked about here with its counts (what it adds, what is there already, what it reports and never touches); a yes applies it pinned to the commit the plan read, each plugin's line in the task's log, and a replay with nothing to add asks nothing. The admin's password is read on the VM and exchanged there for a token, so it never leaves the VM. A deploy now installs porter 0.9.13, whose chell (5.20.0) is the first with `plugin sync`; a store on an older one is refused, naming the deploy replay.
