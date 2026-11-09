---
"@fnndsc/porter": minor
---

A CUBE administrator can read every person's berth from the door at `/berths`, over HTTPS with no SSH. It shows who has a berth running and what it uses, and who has only a home kept. porter hands the caller's token or Basic credentials to CUBE and answers an administrator alone (401 with none or refused ones, 403 for any other user). The berth launcher reads the berths through its local API, so porter never touches the container engine. A client may ask ten times a minute (429 with `Retry-After` past that), and CUBE's verdict on one header is kept for 30 s, so the route cannot be used to make porter hammer CUBE. A porter that starts no berths says so.
