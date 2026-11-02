---
"@fnndsc/stratus": minor
---

A ChRIS stratus deployed gets its users from `chris user add <name> --email <address>`, on the VM.

Every deploy turns CUBE's own sign-up off (`DISABLE_USER_ACCOUNT_CREATION`), so CUBE's API makes no account, the admin's included. `chris user add` makes it on the VM instead, over the bastion path, in the CUBE container, with CUBE's own user model, so the account gets its groups and home folders as a sign-up gives them. It acts on the ChRIS `--on <vm>` names, or the only one this stratus deployed; more than one and no `--on` is refused with their names. `--email` is needed. The password is asked (empty: generated and shown once) or read from `--password-file`, given on stdin, and never kept on this host. A name already there with the same email is left as it is, so a script replays; with another email, or an email another account has, it is refused.
