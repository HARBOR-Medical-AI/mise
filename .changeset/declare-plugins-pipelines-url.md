---
"@fnndsc/brasa": minor
---

A plugin or pipeline line in /bin is checked against the parameters CUBE declares for it, and Tab completes them.

`plugin`/`plugins`, `pipeline`/`pipelines` and `url` are each declared in one record, the last commands to be: every name the shell answers now comes from a declaration, and help, completion and the tool schema read the same record. The words the shell answers itself (`sudo`, `exit`, `!`, `clear`, `prompt`) keep their pages in one small table of their own.

A `/bin` line (`pl-dircopy …`, a pipeline by name, `whatif …`) is parsed against a declaration made from CUBE's own parameters for that version: each parameter an option of its type (`bool` a switch, `int` and `float` numbers, `path` and `unextpath` CFS paths), a pipeline's `--<node>.<field>` options from its manifest, the session's own options (`--detach`, `--parameters`, `--readme`, `--diagram`, …) beside them, and the input operand as paths that glob. The declaration is read once per plugin version (a pipeline: per registration) and kept. `help pl-dircopy` lists every option it takes.

What changes on a line:
- an option a plugin or pipeline does not declare is refused before anything runs (`pl-dircopy-v2.1.1: unrecognized option '--nosuch'`), as is a value not of its type (`--threads two`) and a value given a `bool` parameter; `--flag false` no longer turns a switch off;
- a plugin's one-letter flags work (`-t 4` for `--threads`), posted under the parameter's name;
- a pipeline's `bool` node parameter is a switch; `--node.flag` alone sets it;
- only a `/bin` line's input operands are globbed, never its option values or the `key=value` context after `--`; a word nothing answers (handed to chili) is no longer globbed;
- after `as` in a `/bin` line, Tab completes a path like any operand;
- bare `plugin` is refused with its subcommands rather than printing a usage line; an unknown subcommand of `plugin` or `pipeline` is refused in the parser's words; `plugin run` still says how a plugin runs now;
- `plugin search` and `plugins list` take the listing options every resource command takes; `plugin delete`, `plugin readme`, `plugins overview` and `pipeline delete`, which help listed and nothing answered, are gone from help;
- `pipeline run --previous` takes a whole number of 1 or more, and refuses anything else in the parser's words;
- `url` refuses an option rather than ignoring it;
- `plugin add --json cube:<path>`, `plugin sync cube:<path>` and `pipeline run --paramFile` read the file where CUBE keeps it, following a run's data link.

For a host embedding brasa: `CommandGroup` holds only `declarations` and `shellWords` (its `envelope`, `plain`, `help` and `holds` records are gone); `BackendCompletion` keeps `commandWords` and `rootWords`, and a backend gives the declaration of a word it answers through `BackendFallback.declaration`; `pathnameExpansion_isEligible`, `helpText`, `chris/help.js` and `pipelineRunArgs_parse` are gone; a grammar may declare a family of options (`OptionGrammar.family`). `@fnndsc/brasa/core` exports what a backend declares its commands with: `command_declare`, the grammar types, `declaredCommand_run`, `commandLine_parse`, `commandTools_derive`, `argumentKind_get` and `namedKind_make` (a kind for a word naming one of the backend's things, completed from a list).
