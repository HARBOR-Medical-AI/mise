---
"@fnndsc/stratus": minor
---

A deployed ChRIS gets its own door to mise, porter, under a name of its own: `chris deploy --porter <name>`.

porter (with the chell, calypso and ARGUS it brings) runs as one more service in the VM's compose project, its image built on the VM from Node and the pinned npm release (porter 0.9.2), its session folders in a volume on the data volume. Caddy serves porter's name with its own certificate, and answers to CUBE's name inside the network, so porter's sessions log in to CUBE by its public name without leaving the VM. The registrar is asked for porter's name as for the host's, and the deploy waits for its DNS and its door (`/login`) over HTTPS; a replay resumes. `--porter` needs `--host` and a name of its own. porter's cookie secret is made by the first deploy with a porter and kept beside the others.
