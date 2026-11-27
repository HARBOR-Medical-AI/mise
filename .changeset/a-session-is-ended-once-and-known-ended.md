---
"@fnndsc/porter": patch
---

A session the door ends is ended once, and nobody is handed it while it is being stopped. The idle sweep no longer forgets a session that was started again while the old one was stopping, a login that arrives during a stop waits for it and then looks afresh, and a daemon that ignores the request to stop is killed and confirmed gone.

How: the registry counts each ending of a key's session (a restart, a logout, the sweep) and a login reads that count before it looks for the berth and again before it acts, starting over if it moved. The sweep claims an entry on what is true at that moment, runs one at a time, and forgets only the entry it claimed. A stop that the launcher or Docker failed is an error, not "nothing was running": the sweep keeps the session and says so, and a restart ends its boot as failed without starting a second berth. A restart's boot record stands before the old berth is touched, and a login follows it. On a host that runs sessions as processes, `evict` waits for the daemon to go, sends `SIGKILL` after 15 s, and reports a daemon that survives that; a pid adopted from a berth is signalled only while `/proc` says it is still the process that was adopted.
