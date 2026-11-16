---
"@fnndsc/argus": patch
"@fnndsc/porter": patch
---

The CLOUD tile always answers: a busy console shows the press as queued, and a berth door says why it has no cloud.

A line a control presses while another runs (or before the session's first prompt) used to wait with no echo, so a tile could look dead; it now stands in the transcript as `queued` and runs in place. On a porter that starts berths, `stratus oci` moved the cookie to a cloud session the porter then refused, dropping the person on a failed greet without their ChRIS session; the porter now refuses the switch first, by name, and leaves the cookie alone.
