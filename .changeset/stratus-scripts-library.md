---
"@fnndsc/stratus": minor
---

Scripts live in a library mounted at `/scripts`: git repositories named by `scripts add`, cloned on this host.

`scripts add <name> <repo> [--folder <folder>]` names a repository of scripts (the whole of it, or one folder) and clones it under stratus's state; `scripts` lists the sources with each clone's head; `scripts pull [<name>]` brings a clone up to date, fast-forward only, cloning again one that is gone; `scripts remove <name>` forgets a source and removes its clone. Each source is read at `/scripts/<name>/`, read-only and without its `.git`, so `ls`, `cat`, `play /scripts/<name>/<file>.mise` and `play --status` name one path the script screen (D17) reads too; `/scripts/mine/` is this host's own folder, written to, where a step's edits land as working copies. The sources are kept in `scripts.json` beside the session's configuration.
