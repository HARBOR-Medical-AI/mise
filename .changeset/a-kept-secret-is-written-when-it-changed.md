---
"@fnndsc/stratus": patch
---

Keeping a VM's secrets in the tenancy no longer makes a new version of a secret whose content has not changed.

Every write of a kept secret made a new version, and the cloud holds thirty at a time: a secret reached that limit and could not be written again. A write now reads what the secret holds first and writes only a difference; a secret that cannot be read is left as it is and the keep fails, since writing it unread is how versions are spent. `vm build` still goes on when what is declared cannot be kept first, and now says so in its output with the cloud's reason, where it said nothing. The write is bound to the version it compared, so two writers of the same content, or a write whose reply was lost, make one version between them. What a failed keep says is composed from names and status numbers only, never from an error that may quote what was kept.
