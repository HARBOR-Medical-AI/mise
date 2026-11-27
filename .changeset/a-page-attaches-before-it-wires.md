---
"@fnndsc/argus": patch
---

After a refused token, the next one is tried on the same page: the page no longer reloads to try again.

How: the page used to wire every listener and timer and only then attach, so a refused attach left it wired, and 0.59 answered that by reloading the page before the next attempt. It now attaches first (`ArgusClient.session_attachHeld`): the socket is opened and acknowledged before anything is wired, and whatever the session sends meanwhile is held with that socket and handed over, in order, once every handler is in place (`handlers_install`). A refused attach has wired nothing, so the form takes the next attempt in place. If the session goes away, or the wiring fails, after the attach was acknowledged, nothing is announced as ready, what was held is dropped with its socket (`held_abandon`), and the next attempt is made by a page loaded afresh, as before.
