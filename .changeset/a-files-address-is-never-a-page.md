---
"@fnndsc/calypso": patch
---

A file read through `/vfs` is never served as something a browser runs. A page, a script, a stylesheet, WebAssembly or XML is sent as plain bytes to save; SVG and PDF keep their type and are attachments; every file carries `nosniff` and a policy that sandboxes it and loads nothing. An `img`, a `fetch` and a download are unchanged; only opening a file's address as a page is, which no surface does.
