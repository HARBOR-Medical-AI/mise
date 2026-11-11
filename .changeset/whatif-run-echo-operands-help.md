---
"@fnndsc/brasa": minor
---

A plugin or Pipeline run now says what it resolved to before it starts, and `whatif` prints that and runs nothing. Before dispatch a run names the node it attaches to (or the feed it roots) and its parameters with defaults marked; a Pipeline prints one line per piping, every parameter under `--verbose`. `whatif <line>` takes the same path and stops before the stage, the feed or the job is made, refusing as the real line would. `help operands` holds the operand rules in one place.
