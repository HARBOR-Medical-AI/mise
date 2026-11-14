---
"@fnndsc/salsa": patch
---

A retrieve says why a series ended unconfirmed: the PACS sent nothing of it, or the watch on CUBE's progress was lost. Each such series carries `endCause` (`pacsSilent` or `watchLost`) beside its reason, so a caller can choose its words and next step by cause rather than by reading the reason's text.
