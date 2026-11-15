---
"@fnndsc/brasa": patch
---

A plugin line takes --title, --compute and the run's limits again, instead of refusing them as unknown options.

`pl-dircopy --dir ~/uploads --title "T1 run" --compute host` runs as it did before every `/bin` line was parsed against its plugin's declaration: each plugin's line takes the fields CUBE's plugin instance reads beside the plugin's parameters, `--title`, `--compute_resource_name` (or `--compute`, as `pipeline run` spells it), `--cpu_limit`, `--memory_limit`, `--gpu_limit` and `--number_of_workers`, and posts them under those names. A limit is checked as CUBE writes it (`2000m`, `8Gi`, or a bare number in the field's unit), a compute resource completes from CUBE, and a plugin parameter of the same name keeps the name. A pipeline node's `cpu_limit` and `memory_limit` are checked the same way, and a bare number goes to CUBE as a number.
