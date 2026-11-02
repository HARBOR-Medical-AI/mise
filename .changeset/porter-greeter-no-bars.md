---
"@fnndsc/porter": patch
---

The door and the greet show no scrollbars: the brain never scrolls and is sized to the card; the boot rows scroll without a bar.

`overflow-x: auto` on the brain made its box a scroll container on both axes, so on some screens a frame a few pixels taller than the box grew a vertical bar; it is `clip` now, with the face's size clamped to the card's width. The boot rows keep scrolling to their newest line, bar hidden.
