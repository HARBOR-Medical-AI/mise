---
"@fnndsc/stratus": minor
---

A session reads Oracle's price list once and prices every VM from it, and a build line says what a build would change.

`vm cost` used to fetch the whole price list (about 200 KB) two to four times for each answer; the session now reads it on the first price, says so in that answer, and keeps it (a failed read is not kept), and the `vm cost` model carries `pricesRead`. A build keeps the spec it made the tenancy match (`builtSpec` on the VM's record), so `play --status` says `declared, not built: disk 50 → 180` for a size declared since; a build that grows the data volume alone now counts as built. Under `stratus --fake` the fake tenancy answers what the fake builder applied, so `vm status` no longer marks a VM it built as gone.
