---
"@fnndsc/brasa": patch
---

The General commands (help, set, notes, date and the rest) refuse a bad option before running, and Tab completes them.

`apropos`, `man`, `command`, `version`, `set`, `unset`, `echo`, `printf`, `kill`, `wait`, `joblets`, `fg`, `notes`, `date` and `help` are each declared in one record: grammar, kinds, handler, holds and help together, and their `helpText` entries are gone. `set` and `unset` take a `variable` and complete it from the session's names; `fg` takes a `job`. What changed for a user: an unknown option or a stray operand is refused with the usage before the command runs (`kill -9` and `wait -n` say "invalid option"; `version now`, `joblets x` and `set A B` say "unexpected operand"); `unset A 1x` refuses the whole line rather than removing `A`; `date foo` is refused (a format starts with `+`) rather than ignored; `man pacs -k` is `man -k pacs`; `printf '%d' -5` wants `printf -- '%d' -5`; and a wildcard in the words of `echo`, `printf`, `command`, `kill`, `wait`, `help`, `man` or `apropos` is no longer matched against CFS paths. `echo` and `command` take their words as they come (`grammar: 'expression'`): to `echo` a dash-word past the front is a word, and `command`'s words are the host program's own line. `exit` and `!` are answered by the shell before dispatch and keep their help pages.
