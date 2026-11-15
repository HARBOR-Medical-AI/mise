---
"@fnndsc/fond": patch
---

The error stack can take back messages from a scope as they were, without a second caller prefix.

`errorStack.stack_restore(messages)` puts messages drained from a `scope_run` onto the stack outside it, so work run side by side in scopes of its own still hands its notes to the caller.
