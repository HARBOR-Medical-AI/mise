---
"@fnndsc/argus": minor
---

Folders in the file browser offer DOWNLOAD, and each PACS pull names its level: ALL, PATIENT, STUDY or SERIES.

DOWNLOAD on a folder runs the kernel's `download "<folder>" .` in the console, which archives the tree through the zip pipeline and hands the browser one file; `file download` with a folder indicated does the same. A projection's folder (/proc, /net) is not offered it. In the PACS pane the frame's set pull read `PULL 11` beside a row's bare `PULL`, which read as two different pulls; it reads PULL ALL (PULL ALL SHOWN under a filter) with the count on its title, a series row's reads PULL SERIES, and a patient row is offered PULL PATIENT, one `pull` over every study of theirs.
