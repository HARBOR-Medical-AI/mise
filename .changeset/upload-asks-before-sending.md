---
"@fnndsc/chili": patch
---

A folder upload that is declined, cannot ask, or cannot check its destination now sends nothing.

The question "merge into the folder already there?" was asked inside a block that treated any failure as "the listing failed, carry on", so a "no", and a prompt that could not be shown, were swallowed and the upload went ahead. The question is now asked before the first file is sent, for every folder among the sources and not only a lone one, and nothing catches the answer. A destination that cannot be checked stops the upload, and so does one where a file or a link holds the path the folder would take; only proved absence, or a yes, lets a folder through.
