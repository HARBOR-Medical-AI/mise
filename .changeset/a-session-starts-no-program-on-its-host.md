---
"@fnndsc/menu": minor
"@fnndsc/brasa": minor
"@fnndsc/salsa": minor
"@fnndsc/calypso": patch
"@fnndsc/chell": patch
"@fnndsc/chili": patch
"@fnndsc/stratus": patch
---

A session no longer starts docker, or reads a key file or a checkout, on its host unless its operator granted that tier.

How: a new surface capability, `engineProcesses`, is true for a person's own local shell and, for a daemon, only with the `shell` tier of host control; an attached surface cannot raise it. `plugin add` of an image gives salsa a docker runner only then, and salsa starts none on its own (`plugin_add`'s runner is optional; chili's own command line trusts docker for its process with `hostDocker_trust`). `--ssh-key-file` and `cluster adopt --from` are refused without the `files` tier before the path is touched. `scripts add` and `scripts pull` (git), `vm shell` (ssh-keygen and its session) and chili's `path scan --mermaid`/`--save` and `man doc --browser` need the `shell` tier too; a session without it still lists, opens and plays scripts already there. chili's command is now `dist/bin.js`: importing chili runs nothing. The refusals (`hostDisk_refusal`, `hostProcess_refusal`, `hostTasks_refusal`) now live in `@fnndsc/brasa`'s `core/hostGate`; `lint:hostgate` lists every engine source that imports `fs` or `child_process` with its reason.
