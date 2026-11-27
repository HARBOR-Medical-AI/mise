---
"@fnndsc/menu": minor
"@fnndsc/brasa": minor
"@fnndsc/calypso": minor
"@fnndsc/stratus": minor
"@fnndsc/argus": patch
---

A machine's build, a password set from its row and a PACS export follow what the session says happened.

None of them reads the words a line prints any more.

How: four places in ARGUS decided from wording. A VM build now sends a step event as each of its tasks begins and ends (`stratus.vm.step`: the machine, the step, begun, done or failed, and a plan's counts), and the VM controller draws the run from those, taking only the events of the line it sent itself. A question carries the id of the line that raised it and, where its command names them, what it is for and about (`purpose`, `subject`; `repl_confirm` and `repl_questionHidden` take them): the controller answers a password question from its row only when the question is that row's own line's, for that machine and account, named for that purpose and of the kind expected, and offers YES and NO when a question wants a yes or a no. A line is read as declined from the `line.declined` model and as failed from the session's own error. `pacs query --csv-to` names the file it wrote in its answer's model (`written`), and the PACS pane shows WROTE from that. `desktop load` and `desktop save` act on whether the session did what was asked. A daemon or a surface from before this still works: the new fields are optional, and a question that names nothing is the operator's to answer.
