---
"@fnndsc/brasa": patch
---

The pull summary says why each series ended unconfirmed instead of calling a silent PACS a lost connection. A series the PACS sent nothing of reads `NOT RECEIVED — re-run pull, or check with: pacs status`, with one line saying the PACS sent nothing and CUBE has none of it; a series whose watch on CUBE's progress dropped reads `WATCH ENDED — may still be arriving`, with one line saying its files may still arrive.
