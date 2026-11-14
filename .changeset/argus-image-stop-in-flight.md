---
"@fnndsc/argus": patch
---

A slow DICOM view can be stopped from its own image frame, and what has arrived stays on screen. A STOP block stands in the frame's rail only while the frame is OPENING or LOADING, and Esc does the same when the frame is the focused pane. Stopped while loading, no further slice is fetched, the requests on the wire are aborted, the stack shows the slices on hand, the bar reads `STOPPED AT 37 OF 120` beside the slice, and the block reads LOAD REST, which fetches only the rest. MPR, 3D and SLAB fetch their slices through the same loop (eight at a time, each asked again before it counts as refused), so the same stop reaches them and LOAD REST builds the layout that was waiting. Stopped while opening, the frame's line is cancelled in the session and the field says `STOPPED`. A stopped frame is not a refusal: no red, no REFUSED count, no RETRY. A frame that closes aborts its requests on the wire.
