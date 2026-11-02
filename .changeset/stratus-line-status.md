---
"@fnndsc/stratus": minor
---

A script's `net`, `vm` and `chris` lines say where they stand to `play --status`, from the kept records alone.

`net new` and `vm new` read done when the line matches what is declared and changed with the difference; `net build` and `vm build` read not yet until what they stand on is declared and built, done once built, and changed when the spec was declared again since (every record now carries `declared`); `chris deploy` reads not yet until the VM is built, changed when the profile, compute, host or porter differ from what was deployed or the VM moved under it, ready while a host waits on DNS, done once deployed; `chris user add` reads not yet without a ChRIS and ready otherwise (CUBE is asked only when it runs). `vm cost` and `chris status` read as a dash: they keep nothing.
