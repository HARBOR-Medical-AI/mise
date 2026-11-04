---
"@fnndsc/stratus": patch
---

A VM's teardown is watched step by step, and `chris deploy` says on the machine itself what it put there.

A VM teardown's two parts (the machine, then the data or its keeping) are steps on its record, each sent as the VM's row as it begins and ends, so a screen draws it going and gone. `chris deploy` tags the VM's instance with the CUBE API's address and porter's name, and a VM found in the tenancy reads them back, so a session that keeps no record of it still knows what runs on it.
