---
"@fnndsc/menu": patch
---

A cluster carries its teardown's steps, and reads PARTLY TORN when a teardown stopped part way.

The summary gains `teardown` (when it started, and each of destroy, dns, image, volumes, stack, compartment and installer where it stands: not done, running, done, skipped or failed) and the condition PARTLY TORN.
