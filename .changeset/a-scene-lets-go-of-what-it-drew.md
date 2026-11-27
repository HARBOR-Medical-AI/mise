---
"@fnndsc/orrery": patch
---

A graph that is redrawn, or closed, gives back the graphics memory it used, and stops drawing while its pane is hidden.

How: each drawn field (spheres, stars, tubes, the census, captions) keeps what it made and disposes its geometries, materials and textures when the scene is redrawn; what several draws share (the cached sphere shapes, the one tube shape, the nebula glow) is marked and kept. Closing the scene also clears those fields, disconnects the observer of its box and removes the hover tip. The frame loop asks for no frames while the scene's box has no size, and starts again when the box has one.
