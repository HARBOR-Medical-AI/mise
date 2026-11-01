---
"@fnndsc/stratus": minor
---

Networks for VMs are declared, built and torn down with `net`. `net new <name> --cidr <range>` declares a network and builds nothing; on one already declared it prints `unchanged` or the change. `net build` plans as a task, says the counts and asks, then applies; a plan that touches what exists is refused unless `--allow-alter`. On OCI a network is a compartment of its name (an empty one is adopted), a VCN, an internet gateway, the default route and security list (SSH only from inside), one public subnet and an OCI Bastion admitting only this host's public address, all from a Terraform module stratus keeps, run in Resource Manager and tagged `mise-net=<name>`. `net teardown` refuses while anything stands in the compartment, then asks for the name typed back.
