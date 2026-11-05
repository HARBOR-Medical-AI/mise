---
"@fnndsc/stratus": minor
---

A cluster's build asks before it makes anything, and both its questions price what SIZE priced.

`cluster build` asks first, before its first step, with everything it makes before it bills (the compartment, the records at Red Hat, the discovery ISO and its public link, the plan) and the rate it would bill at; a NO makes nothing. Billing is asked again before infra-apply with the plan's count. Both price a spec whole: compute and memory, the boot and ChRIS volumes, the load balancers. A cluster built here is counted in its compartment on `cluster status`, with when. A network keeps the CIDR its build made; a new CIDR on a built network says what it would replace as it is declared; `net status` answers a model of what stands.
