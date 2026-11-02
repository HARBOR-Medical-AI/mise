---
"@fnndsc/brasa": minor
---

Where every line of a script stands, without running one: `play <manifest> --status`.

Each line is expanded as a dry run expands it, then the verb it begins with says, from what the backend keeps and never from the cloud, one of four states: not yet (with what is missing), ready, done (the line replays to unchanged or nothing to do), or changed (with what changed under it). One row per line, a count at the end, and a `manifest.status` model a surface colours its rail from (docs/stratus.adoc, D17). A backend answers for its verbs through `Backend.lineStatuses`; a verb that keeps nothing reads as a dash.
