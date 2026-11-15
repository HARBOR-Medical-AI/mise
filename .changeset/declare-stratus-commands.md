---
"@fnndsc/stratus": minor
---

Every stratus command checks its line before it runs; Tab completes its options, clusters, VMs and networks.

`cluster`, `capacity`, `spend`, `net`, `vm`, `chris` and `scripts` are each declared in one record, in their own modules: grammar, argument kinds, handler, holds and help together, as brasa's commands are. A line is parsed with GNU `getopt_long` rules against the grammar before anything runs, and a bad one is refused in the parser's words with a usage generated from it; `help`, completion and the tool schema read the same record. stratus registers its own argument kinds through the backend seam: `cluster`, `vm`, `network` and `chrisProfile`, each completing from what the session keeps. `capacity` and `spend` still hold nothing of the session.

What changes on a line:
- an unknown option, a missing operand, an extra word and a word that is no subcommand are refused by the parser (`cluster: adopt: unrecognized option '--colour'; usage: …`) rather than in each command's own words;
- `cluster protect <name> maybe` and `vm protect <name> maybe` name the values the setting takes (`on`, `off`);
- `net <name> <word>`, `vm <name> <word>` and `cluster <name> <word>` refuse the extra word rather than reading the first as a verb;
- `vm cost --memory 16` with no VM says the options need a VM to price;
- `chris user mod … --password-file` is refused naming `chris passwd`;
- `vm shell --print` is taken (as before) and documented.

For a host embedding stratus: `CLUSTER_HELP`, `CAPACITY_HELP`, `SPEND_HELP`, `NET_HELP`, `VM_HELP`, `CHRIS_HELP` and `SCRIPTS_HELP` are gone (each command's prose is in its declaration: `clusterCommand_make(context).help`); `stratusCommands_make` returns a group of `declarations`.
