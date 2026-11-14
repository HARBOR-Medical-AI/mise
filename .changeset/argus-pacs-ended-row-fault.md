---
"@fnndsc/argus": patch
---

An ended PACS pull row is drawn as a fault with its own PULL, and no row stays QUEUED once its pull ends. `NOT RECEIVED`, `STOPPED AT 12/40`, `TIMED OUT AT 12/40` and `✗ ERROR` read in the alert hue with a PULL at the end of the row that pulls that series again; `? UNCONFIRMED 12/40` keeps its own hue, since its files may still be arriving. Every PULL the pane sends is followed to the end of its joblet: a pull refused at its start, failed, or stopped before it reported on a series settles that series as `NOT RECEIVED` with the pull's own error as the reason.
