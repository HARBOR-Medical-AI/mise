---
"@fnndsc/argus": patch
---

A token that is refused no longer leaves the page's buttons firing twice on the next try.

How: the page's start is in a module of its own and begins one attach at a time; pressing Enter twice wires the surface once. After an attach that failed, the next attempt reloads the page and the fresh page attaches with the new token, carried in the tab's session storage for that one load and never put in the address. An attach whose socket closes before the daemon answers is rejected instead of waiting for ever.
