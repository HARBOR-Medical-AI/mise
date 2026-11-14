---
"@fnndsc/chell": patch
---

A question asked of a chell whose input is closed now fails at once instead of waiting forever.

Outside the REPL (`chell -c`, `chell --remote … -c`), a question on a standard input that has ended, or ends before a line is typed, fails with "no input to answer the question: standard input is closed", and the command that asked is told.
