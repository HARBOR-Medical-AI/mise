---
"@fnndsc/menu": patch
"@fnndsc/argus": patch
---

Text written into a quoted attribute cannot end it: both quotes are escaped. `html_escape` now escapes `"` and `'` as well as `&`, `<` and `>`. ARGUS's prompt bar no longer writes markup at all: each segment is an element whose text and title are set as properties, so an identity or a path that reads as markup is shown as what it is. A quoted string in a `/bin` summary is now coloured as a string, which the highlighter always meant to do.
