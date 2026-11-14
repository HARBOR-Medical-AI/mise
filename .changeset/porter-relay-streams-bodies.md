---
"@fnndsc/porter": patch
---

A file of any size can be posted through the porter. A body under a session's mount goes on as it arrives, never held or refused by size. The porter's 1 MiB body limit answered a posted file 413 (and 500 when it came form-typed); the daemon's own limit on `POST /vfs` (256 MiB) is the only one now, and a request with a body has no relay deadline while the daemon puts it in CUBE. An answer that stops part way after its 200 is a line in the porter's log (`the file stopped arriving part way: /vfs <path> after n bytes of m (<cause>)`), and a socket the session closed before answering reads `the session closed the connection before it answered (<cause>)` rather than `the session did not answer`.
