---
"@fnndsc/argus": patch
---

The controller's TEAR DOWN in a READ session asks the password rather than reading REFUSED, and its guard says so.

The kernel's refusal no longer carries the mode, so a lifted lock leaves TEAR DOWN asking first; a torn-down cluster with nothing left no longer stands as a pill in the header (docs/stratus.adoc, D14, D15).
