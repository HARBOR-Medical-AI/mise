---
"@fnndsc/argus": patch
---

A PACS series whose pull ended without its files says so, with the reason, and can be pulled again. The row reads `NOT RECEIVED` when none of its files came, `STOPPED AT 12/40` or `TIMED OUT AT 12/40` when they began and ended early, `? UNCONFIRMED 12/40` when the watch lost sight of it, and `✗ ERROR` for a failure; the reason is the badge's title and one line in the console. A bar moves only for a pull that is queued or running, PULL and the PULL count take the series again, and a series its pull ended without a word on is settled as not received.
