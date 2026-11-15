---
"@fnndsc/cumin": patch
---

A transfer pool moves files to or from CUBE several at a time, each failed file tried once more.

`transferPool_run(items, work, { jobs, signal, retries, onSettled })` keeps at most `jobs` items in flight (1 to `TRANSFER_JOBS_MAX`, 32; `TRANSFER_JOBS_DEFAULT` is 8), tells each item as it settles, retries a failed one once, and answers what moved, what failed with its reason, and what a cancel left. A fired signal starts nothing new and reaches the work in flight. Each attempt runs in an error-stack scope of its own, so transfers side by side never drain each other's notes, and the last attempt's notes reach the caller's stack. Also at `@fnndsc/cumin/transfer-pool`, which loads nothing else of cumin.
