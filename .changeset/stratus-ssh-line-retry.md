---
"@fnndsc/stratus": patch
---

A deploy no longer fails at its second step when the VM's bastion session is brand new. Every line sent to a VM is tried again (six tries, ten seconds apart) when ssh itself failed to carry it; a line the VM ran is never repeated.
