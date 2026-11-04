---
"@fnndsc/salsa": patch
---

A /proc/jobs path naming one feed resolves that feed alone on a fresh session, while the index builds behind.

`ls /proc/jobs/feed_N` and a `cd` into a node's `data` waited on the whole feed index (minutes on a tenancy with many feeds) before answering (#1364). A path naming one feed now reads that feed's row and topology and answers; `/proc/jobs` itself still needs the index. `workflowFeedIDs_get` asks CUBE which feeds a workflow's jobs are in, for a search scoped to one run.
