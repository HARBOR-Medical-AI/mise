---
'@fnndsc/stratus': minor
---

The OpenShift cluster's verbs are `cluster` now, freeing `domain` for the Trusted Domain recipe. They are `cluster new`, `plan`, `build`, `status`, `verify`, `adopt`, `teardown`, `protect`, `size` and `attach` (docs/stratus.adoc, D16). The tenancy's folder is `clusters/`, the tag that finds a cluster in the tenancy is `mise-cluster=<name>`, the expect subject is `cluster`, the launcher's checkout flag is `--cluster NAME=CHECKOUT`, and the state event is `stratus.cluster.state`. A daemon starting where the old `stratus/domains/` folder stands and `stratus/clusters/` does not moves it once. The Kubernetes driver's folder is `src/kube/`. Clusters built before this carry `mise-domain`; retag their stacks and compartments to `mise-cluster` so the session finds them.
