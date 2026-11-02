---
"@fnndsc/stratus": patch
---

A refusal in a READ session says what the operator chose and where MANAGE is chosen, never the tier's name.

`net build`, `vm build`, `chris deploy`, `chris user add`, every teardown and the plans say `entered as READ, so nothing outside this host changes; MANAGE is chosen at the door (porter asks it; in chell, stratus oci manage), so enter again`; `cluster status` carries that hold on BUILD, ADOPT and TEAR DOWN for the controller (docs/stratus.adoc, D14).
