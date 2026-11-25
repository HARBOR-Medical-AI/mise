---
"@fnndsc/cumin": patch
"@fnndsc/salsa": patch
---

A long listing is walked by the server's own word on whether more follows, not guessed from a page's length.

cumin read the next-page flag under a name the ChRIS client does not have, so the answer was always "unknown" and a walk could only guess from the length of a page. It now reads the client's own `hasNextPage`, which comes from the collection's `next` link, and the strict walk refuses a page that carries no links. In salsa's proofs an id beyond the range a number holds exactly, or text that is not plain digits, is no longer taken for an id.
