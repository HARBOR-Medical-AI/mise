---
"@fnndsc/stratus": patch
---

A teardown is seven steps kept on the record as each ends, so it is watched step by step and resumes where it stopped.

A teardown was one job with seven removals inside it, and the record learned only the final `gone`: a teardown that stopped part way (the daemon restarted under it) left a record that still read SERVING. Now each removal is a step (destroy, dns, image, volumes, stack, compartment, installer, in that order), begun and ended on the record with its time and what went, the state shown after each so a surface watching redraws; `cluster <name>` lists them. A cluster with steps done and no `gone` reads PARTLY TORN, bills nothing once the destroy is done, and refuses build, plan and verify; `cluster teardown` on it lists what an earlier pass finished and resumes at the first step not done, asking the name again.
