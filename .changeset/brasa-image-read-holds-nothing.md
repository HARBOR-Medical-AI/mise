---
"@fnndsc/brasa": patch
---

Opening an image no longer makes every other line of the session wait, and a stopped open ends at once. `image` and `dcm` are reads and hold nothing of the session, so they run beside any other line. Both honour a stop (STOP or Ctrl-C) between their reads and answer `image: stopped` or `dcm series: stopped`; a read already sent to CUBE runs to its answer, which is dropped.
