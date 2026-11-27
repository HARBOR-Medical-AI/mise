---
"@fnndsc/argus": patch
---

A closed pane lets go of everything it took. The image viewer no longer leaves volumes behind in memory, and a closed feed graph or machine screen stops working in the background.

How: the image engine keeps its metadata provider and its load-failure listener and removes them when it is let go; each volume it makes is released when the layout that used it is replaced (a slab build no longer adds one per build), and an engine let go, or a layout replaced, while a volume is being made installs nothing when the volume arrives. The feed graph pane disconnects its observers (two were on the document), removes its window listener and stops its timers. A listing can be let go: its listeners go through one signal, its observers are disconnected, and a column drag in hand ends. The machine screen stops its run tick, its lever wait and the script screen's standing poll, and starts none after it has been left.
