---
"@fnndsc/brasa": patch
---

A pull sent to the background with `&` no longer waits on a question nobody sees. On a silent PACS a pull in front asks whether to keep waiting; as a joblet the same question waited for an `fg` while every silent series went on reading as in flight. A pull reads that it runs in a joblet and asks nothing there: it waits 60 seconds of silence, then ends each silent series with its reason, which its log prints under the series. A pull from a script with no one to ask stops after the same 60 seconds.
