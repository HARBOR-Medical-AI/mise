---
"@fnndsc/salsa": patch
"@fnndsc/chili": patch
---

Sharing a file by its id now says that it cannot, instead of printing a line and reporting success with nothing shared.

salsa's `files_share` never shared anything: it printed "Sharing file ..." and answered true. It now answers false, leaves the reason on the error stack, and prints nothing; chili's file controller reports that reason. Permissions are set with `setfacl`.
