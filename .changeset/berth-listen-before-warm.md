---
"@fnndsc/brasa": patch
"@fnndsc/menu": patch
"@fnndsc/calypso": patch
"@fnndsc/chell": patch
"@fnndsc/argus": patch
"@fnndsc/porter": patch
---

A berth login is no longer refused while the berth is alive and still warming up.

A daemon session listens and writes its berth file once it has connected to CUBE and listed `/bin`; the person's feeds, `/PUBLIC`, `/SHARED`, the groups and the PACS query index warm with it already answering, and Engine Ready is said when the last of them settles. While they run, every prompt context names them (`warmupPending`): chell's prompt says `[warming: public queries]` and ARGUS's status strip `WARMING PUBLIC QUERIES`. The berth launcher waits for the berth file as long as the container runs and its log moves, refusing a berth that stopped (with its last lines), one whose log wrote nothing for 90 s, or one still starting after 240 s; a login while a berth runs with no berth file yet joins that wait instead of being refused with `no berth file yet`.

porter's login page shows a berth's own boot rows as it boots: the launcher follows the berth's log once, for its wait and for the page, and relays each line to porter (a start asked with `?follow=lines` is answered as NDJSON, the lines then the answer); the attach token is taken out by the launcher and again by porter, which settles an open `[PENDING]` row in place as it does for a session beside it. A launcher from before answers plainly and is read as before.
