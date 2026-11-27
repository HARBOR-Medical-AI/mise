---
"@fnndsc/argus": patch
---

After a refused token, the next one is tried on the same page: the page no longer reloads to try again.

How: the page used to wire every listener and timer and only then attach, so a refused attach left it wired, and 0.59 answered that by reloading the page before the next attempt. It now attaches first (`ArgusClient.session_attachHeld`): the socket is opened and acknowledged before anything is wired, and whatever the session sends meanwhile is held with that socket. The page installs its handlers, binds its client and applies what the attach said; only then is what was held handed over, in order (`held_release`), so a later word of the session wins over the attach's; only then is READY said. A refused attach has wired nothing, so the form takes the next attempt in place. If the session goes away while the page is setting up (it is noticed at once), or anything fails after the attach was acknowledged, nothing is said ready, the client's handlers are taken away and its socket closed (`held_abandon`), and the page is left at once for a clean one that shows the form and why.
