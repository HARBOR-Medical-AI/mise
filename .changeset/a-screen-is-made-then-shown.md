---
"@fnndsc/argus": patch
---

Leaving the VM controller or the script screen stops every clock it started, by one call.

How: the two screens are one class over another, and each kept its own timers as fields of its own (the header's tick, a price asked a moment after a lever moves, a standing read again, a run's one-second tick), so leaving had to remember each in both. They are now held by name in one place (`ScreenTimers`) and stopped together; nothing starts on a screen that was left. The script screen no longer draws while it is being constructed: it is made, then shown (`screen_show`, which opening a script or a machine does too), so the VM controller is whole before anything of it is drawn, and no longer needs fields set after the fact or a draw that returns early on its own unset state. Nothing an operator sees is laid out differently.
