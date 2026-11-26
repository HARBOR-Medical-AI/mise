---
"@fnndsc/calypso": patch
---

A session holds only so many uploaded bytes at once. An upload that would pass the ceiling (`CALYPSO_UPLOAD_HELD`, 512 MiB unless set) is answered 503 with `Retry-After` and is taken when one in flight has ended. A stated length is checked before anything is allocated and the body must match it exactly; a body with a stated length is held once, not twice.
