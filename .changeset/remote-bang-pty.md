---
'@fnndsc/menu': patch
'@fnndsc/calypso': patch
'@fnndsc/chell': patch
---

A full-screen program run with `!` from a remote chell in a terminal now draws, takes keys and quits back to the prompt. A remote chell whose input and output are a terminal declares its type and size on attach (`tty`); the daemon runs that surface's `!` on a pseudo-terminal of its own and relays bytes, keys and window sizes (`hostPtyStart`, `hostPtyData`, `hostPtyExit`, `hostPtyInput`, `hostPtyResize`), and the line ends with the program's exit status. A surface with no terminal keeps pipes, and Neovim there, which would wait forever for a user interface, is refused by name instead of holding the session (#1498).
