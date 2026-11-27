---
"@fnndsc/menu": minor
"@fnndsc/argus": patch
"@fnndsc/chell": patch
---

A file, folder or name with a quote, a dollar sign or a semicolon in it is acted on as itself by every button and form.

How: `@fnndsc/menu` gains the one way a surface writes a value into a line for the mise shell: `arg_quote` (single quotes, in which the shell takes every character literally), `word_write` and `path_write` (bare when the value is one plain word, quoted otherwise), `path_quote`, `home_path` (the tilde outside the quotes), and `line_split` and `script_lines` to read such lines back. ARGUS's buttons and forms wrote paths in bare double quotes, in which the shell still expands `$NAME`, or not quoted at all; all of them now go through these. A line shown in the console therefore reads `cd '/home/u/my folder'` where it read `cd "/home/u/my folder"`. ARGUS's own verbs (`file`, `pane`, `desktop`, a saved view) honour the same quotes, so a view can name a folder with a space in it, and a view from elsewhere is judged by the allow-list on the same words that would run. A run line's `;` and ` -- ` inside a quoted value are no longer taken for the line's own.
