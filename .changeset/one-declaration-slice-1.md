---
"@fnndsc/brasa": patch
---

Tab completes `berth`'s subcommands and paths; `ls`, `download` and `berth` refuse a bad option before running.

`ls`, `download` and `berth` are each declared in one record: name, grammar (subcommands, operands, options), the kind of every argument, handler, holds and help. The engine parses their lines against it with GNU `getopt_long` rules (bundled `-rf`, `--name x` and `--name=x`, `--`, options anywhere among the operands), expands only path operands that declare a glob, then checks values; a bad line is refused in plain words with a usage generated from the grammar. `help`, completion (subcommands, option names, values by kind) and a JSON Schema per command and subcommand read the same record. `ls dir -l` works; `download`'s destination never globs. Argument kinds come from the core, and a backend registers its own through `Backend.argumentKinds` (ChRIS: `anchor`). Two ratchets count the builtins not yet declared and the commands with an expression grammar of their own.
