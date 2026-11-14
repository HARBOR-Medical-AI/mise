---
"@fnndsc/calypso": patch
---

A file whose bytes arrive whole, as every PACS file does, is served by the session instead of ending it.

`GET /vfs` takes a file's bytes in any form the engine hands them in: a Node stream, a web stream, an older stream with only `on` and `pipe`, or the whole file as a Buffer, byte array or string. Anything else is answered with a 500 and one log line. A file route that throws is answered and logged, never left to end the daemon, which is what a pulled PACS series did when opened in the image pane.
