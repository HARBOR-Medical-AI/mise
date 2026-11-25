---
"@fnndsc/brasa": patch
---

The session lays the universe out again: its layout worker is found, and a layout it could not lay out is said.

The session started its layout worker from a path that named no file, so every layout failed there and the failure was swallowed; a surface then laid each graph out itself, every time. The path is right now, a layout the session cannot lay out leaves a warning with the layout's name and the reason, and two checks hold it: one that every `new Worker` in the sources names a file that is there, and one that starts the worker from the built package and lays a small graph out.
