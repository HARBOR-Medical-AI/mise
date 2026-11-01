---
"@fnndsc/stratus": minor
---

ChRIS goes on a built VM with `chris deploy <vm> --profile minimal`. Over the network's bastion, as a task, it writes CUBE 6.11.0's production compose (CUBE under uvicorn, its workers and scheduler, Postgres, Dragonfly, NATS, pfcon 6.0.7 in-network running plugins through the VM's Docker, Caddy in front) to the data volume, starts it, waits for CUBE, registers the compute resource (`--compute`, default the VM's name) and checks `chris` sees the admin API. The internal secrets are generated once and kept on this host; the admin password is asked once (empty: generated and shown once) or read from `--admin-password-file`. A VM below the profile's floor is refused and told by how much. With `--host`, it waits for public DNS to give the name the VM's address and for the certificate, and a replay resumes there. `chris status` says what is deployed where.
