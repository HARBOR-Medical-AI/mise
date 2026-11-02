---
"@fnndsc/stratus": minor
---

What the cloud sells a VM is one question, `vm limits`, answered in the spec's own words.

`vm limits` reads the shape VMs are built from in the session's region and says, in `vm new`'s words, what it allows: vCPUs from the least to the most in the cloud's steps (OCI sells E5.Flex by the OCPU, two vCPUs at a time), memory in GiB and per vCPU where the cloud bounds it, the disks' floors and ceilings. A slider in the script screen (D17) takes its ends and steps from this answer and never from a page; the per-vCPU memory range comes to `CloudShape` as `memoryPerVcpuGib`.
