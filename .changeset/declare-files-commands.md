---
"@fnndsc/brasa": patch
"@fnndsc/salsa": patch
"@fnndsc/chili": patch
---

Every file command reads and writes through a run's `/proc/jobs` data link and any `.chrislink`; Tab completes their options.

`cat`, `grep`, `wc`, `head`, `tail`, `sort`, `uniq`, `cut`, `cp`, `mv`, `rm`, `rmdir`, `mkdir`, `touch`, `find`, `edit`, `config`, `upload` and `file` are each declared in one record: grammar, argument kinds, handler, holds and help. `find` declares an expression grammar of its own, with its own completion of tests, `-type` and `-status` words, and paths. Their lines parse with GNU `getopt_long` rules (`--highlight[=language]` takes its value only in its own word; `head -5` is `head -n 5`) and a bad one is refused in the parser's words with a usage generated from the grammar.

Every file command, readers and writers, now finds where a path lives in CUBE through one resolver (`storePath_resolve`), and so does the dispatcher for any path handed to the store, `cd`, `tree`, `du`, `ls -d` and berth. A write through a link lands in the folder the link points at; `rm`, `rmdir` and `mv` act on a link itself, never on what it points at; `find` walks a starting point at its target and lists links below it as links. CUBE's link walk (`logicalPath_resolve`, the path mapper) moves from chili to salsa; brasa's own `/proc` regex in berth, the physical-mode link walk and `cd`'s parent-listing lookup are gone.

What changes on a line:
- the GNU flags people use run in the session on every surface: `sort -h -V` beside `-n -r -k -t -u -f`, `head -c N` and `tail -c N`, `tail -f` (a ChRIS file or a pipe is read once, and it says so), and grep's `-n -l -o -h -H -r -A -B -C` and `--color[=WHEN]` beside `-i -v -w -E -F -c -e`; a flag none of them takes is refused rather than handed to the system program (`command sort …` still reaches it), and so are `sort -k2n` and a second `uniq` operand;
- `grep` reads named ChRIS files itself (`name:` before each line for more than one, the path as typed), rather than handing a file operand to the system grep; with `-e` every operand is a file and globs; for a numbered listing the line-and-file flags (`-n -l -o -h -H -r -A -B -C`) are refused, since a listing keeps whole rows; its footer spells the line from its options (`grep -i -v x`);
- `cat --highlight --no-highlight` does not highlight, whichever comes last;
- `cp`, `mv`, `rm`, `rmdir`, `mkdir`, `touch`, `cat`, `edit` and `upload` with too few operands are refused by the parser with exit status 1, rather than printing their usage; `edit` refuses a second operand rather than ignoring it;
- `cp -t … -r` copies folders; `cp` and `mv` take `--target-directory <dir>`;
- `config write <path> <base64>` writes again (it had been refused with its usage whatever it was given);
- `upload` exits 1 when any file fails, and tells a wildcard in its source by its characters;
- `find` and `upload` operands are no longer globbed by the shell before the command sees them (`find` never globs; `upload` matches its own host source);
- `tree`, `du` and `find` given a `/proc/jobs` data path or a link draw, size and walk its target, shown under the path as typed: `tree <path>` hangs from that path rather than from the root, and `tree --path` and `du` name every entry under it.
