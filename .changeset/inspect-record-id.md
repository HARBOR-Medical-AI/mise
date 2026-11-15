---
"@fnndsc/brasa": patch
---

Inspecting a job by its id works again (`jobs inspect <id>`), showing every field of that job with its value.

`inspect` on `jobs` (and every other name of `plugininstance`), `feed`, `tag`, `pluginmeta`, `workflow` and `compute` takes an optional id and shows that record, every field with its value; an id CUBE holds no record of is said and exits 1. With no id it names the fields, as before. The declared commands had refused the id since the move to declarations.
