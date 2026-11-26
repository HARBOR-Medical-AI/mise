---
"@fnndsc/cumin": minor
"@fnndsc/brasa": minor
"@fnndsc/chell": patch
"@fnndsc/chili": patch
"@fnndsc/stratus": patch
---

Whoever is connected now is who every request is made as, and whose answers are kept. A transfer made under `sudo` no longer leaves later transfers running as the administrator, and after `connect` as another user, or to another CUBE, nothing is sent with the first user's token or answered from what the first user was shown (`/bin`, listings, the job tree, tags, PACS facts, the query index). Logging out drops the client as well as the token.

How: cumin's transfer, feed, plugin, resource and file-browser classes ask the connection for its client each time and keep none. A change of identity (a login, a context that names another user or CUBE, a logout) is numbered, in `@fnndsc/cumin/identity-epoch`: the caches empty themselves at each change, take a fill only from work begun under the identity now connected, and neither answer nor keep anything for work done as another user. A line of input is begun as one such piece of work through a new optional `Backend.work_run` in brasa, and the boot warm-up is another. Checkpoint watchers and the query index's flush at exit stop writing under an identity's name once another has connected.

Also: two downloads at once each report their own reason when CUBE refuses them; a folder's record is kept under one spelling of its path (`home/a`, `/home/a` and `/home/a/` are one), and deleting a folder by path no longer waits out its timeout on a remembered copy; two commands captured from chili at once no longer take each other's output; and a pause in a VM build no longer leaves a listener behind on the build's signal each time it ends.
