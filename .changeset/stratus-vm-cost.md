---
"@fnndsc/stratus": minor
---

What a VM would cost is a question of its own: `vm cost`, in `vm new`'s words, declaring nothing.

`vm cost <name>` with `vm new`'s options says what that VM bills at list price, an hour and a month, and what its data alone keeps billing after a teardown. On a declared VM the options given change its spec for the answer and the difference is said (`vm cost store --memory 16`: `$0.052 → $0.068 an hour, … (+$11.68 a month)`); on a name not declared they are the whole spec, and `--net` is not needed, the price being the session's region's. Bare, `vm cost` prices every declared VM. Nothing is declared or saved.
