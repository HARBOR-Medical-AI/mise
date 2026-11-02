---
"@fnndsc/argus": minor
---

The script screen: `scripts` in a stratus session takes the display over the library, one script's lines as its rail.

`scripts open <path>`, OPEN on the library or a row on the new SCRIPTS tile opens a script. Each seat is a line (NET NEW, NET BUILD, VM NEW, VM BUILD, CHRIS DEPLOY, every `chris user add` line under USERS) wearing the state `play --status` read for it: not yet, ready, done or changed. A step's body is a form over its line, the line shown as it will run, RUN sending it as the operator could have typed it, the console's output under it as the proof. VM NEW's sliders take their ends and steps from `vm limits` and re-ask `vm cost` as they move, the price in the header beside what the declared VMs bill now; VM BUILD carries PROTECT and TEARDOWN (the machine, or `--all`, redder); USERS lists the user lines and ADD appends the next. A form's edit is kept as a working copy under `/scripts/mine/` by SAVE, the editor's own `touch --withContents` line. The engine's questions stand on the strip with CONTINUE and STOP; a hidden word is typed unseen. LEAVE or Esc gives the page back. Drawn in the ARGUS frame, which now lets a screen replace its views, with the TD controller's classes (docs/stratus.adoc, D17).
