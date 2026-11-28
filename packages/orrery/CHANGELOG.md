# @fnndsc/orrery

## 0.7.1

### Patch Changes

- f3d36b1: A graph that is redrawn, or closed, gives back the graphics memory it used, and stops drawing while its pane is hidden.

  How: each drawn field (spheres, stars, tubes, the census, captions) keeps what it made and disposes its geometries, materials and textures when the scene is redrawn; what several draws share (the cached sphere shapes, the one tube shape, the nebula glow) is marked and kept. Closing the scene also clears those fields, disconnects the observer of its box and removes the hover tip. The frame loop asks for no frames while the scene's box has no size, and starts again when the box has one.

## 0.7.0

### Minor Changes

- 02c20bf: Every function name now says what it does: the 462 that put a preposition where the verb goes are renamed (#1227).

  The style guide names a function `<subject>[Qualifier]_<verb>[Adverb]`. Names such as `answerRows_of`, `seriesUID_ofPath`, `options_toParams` and `ask_onPane` put a preposition in the verb's place, which names the result without saying whether the function derives, parses, builds or renders it. They are now `answerRows_derive`, `seriesUID_parse`, `options_convertToParams` and `askOnPane_await`. A preposition may still qualify the verb (`x_readFromCache`) or the object (`askOnPane_await`); it may not start the method.

  `npm run lint:rpn` (`scripts/rpn-prepositions.mjs`) refuses a function, `const` function or underscored method whose method is, or starts with, `of`, `to`, `with`, `from`, `for`, `by`, `as`, `in`, `on` or `at`, and CI runs it. The exported names change with no aliases kept: nothing outside this repository imports them.

## 0.6.2

### Patch Changes

- 11a9212: A census is drawn as smoothly as a shape, and blooms with the wave. Census members took an 80-face icosahedron, faceted on a 4K screen; the cut now scales with how many are drawn (980 faces up to 2,000, 320 up to 20,000, 80 past that). Each census stage blooms as the wave lands on it, as a lone node's lamp does (none past 400 stages). PULSE stands on by default; a feed view kept before reads the new default for pulse alone.

## 0.6.1

### Patch Changes

- a0f0160: Jump to a feed or a node by its number (#1061). `proc jump 639204` goes to the node, `proc jump feed_4389` to the feed, asking CUBE for anything shared since the roster was walked. A bare number that is both a feed and a node is never guessed: chell names both, and RUNS asks which. RUNS gains JUMP TO on the roster frame: it asks for the number, enters the feed, and selects the node once the graph is drawn, without moving the console's working directory.

## 0.6.0

### Minor Changes

- f9244ad: The universe's star threads now carry the pulse wave in SHAPE mode too, not only in CENSUS. A finished run's threads replay stage by stage and a live stage's stream; faint scenery rests, and a thread a replay or hand-off has hidden carries no wave. `universe state` also reports the median edge length and the longest edge with the two stages it joins.

## 0.5.0

### Minor Changes

- bd0af06: A census's connecting lines now carry the pulse wave, so information travels down every connection in a big feed. Past 20,000 connections a census draws lines instead of tubes, and under STARS it always draws threads; both used to sit still and now stream into a live stage and replay a finished run exactly as tubes do.

## 0.4.1

### Patch Changes

- dc75d9b: CENSUS on a feed shells every job again, in RUNS and inside a universe descent, instead of looking like SHAPE. A feed view's nodes are tubed but no longer marked solid, so orrery's census no longer holds them out; the canvas now says how many jobs the census holds (`data-census`).

## 0.4.0

### Minor Changes

- c5e033d: A feed now looks the same from the RUNS roster and from the universe. Either way it is one tree, root on top, every node lit with its tube. Both doors read the feed with one builder, and the universe's descent lays the feed out as that tree and holds it there instead of settling it into a free-form burst. An orrery unfold can now take positions the surface laid out itself (`placed`), held where they are put.
- 71fe8a5: A feed has one frame and one memory, whichever door opens it. RUNS and the universe's descent carry the same verbs (arrangement, 3D, SPHERES/STARS, pulse, metric, hue, census, gravity, and the feed's note, tags and name), and the modes this device last chose stand in both, so a feed switched to MOLECULE in the universe opens as MOLECULE in RUNS. Inside a feed the universe shows the feed's verbs and steps the space-only ones aside; its own draw style comes back on the way out. STARS now works inside a feed: nodes become points of light on fine threads, where before every feed node stayed a sphere. An orrery node can be `tubed` without being solid.

### Patch Changes

- de04249: The scene says whether what it drew stands as a tree, roots on top. After each draw it writes `data-roots-top` on its canvas, beside the fit count, from the lit nodes' heights, so a check can confirm a feed opened as its tree from either door.

## 0.3.0

### Minor Changes

- baec61d: The UNIVERSE's 3D / 2D block acts on what is in view. Inside a feed it used to flatten the whole galaxy behind the one feed being read; now that feed alone settles flat on the plane through its centre that faces the eye, keeping the spread it had, the camera frames it again, the idle spin rests, and the space behind keeps its depth. Outside a feed the whole space flattens as before. Each feed is entered in 3D; BACK leaves the flat reading with the feed. orrery gains `flat_set(ids)` / `flat_get()` (a new graph ends it) and the `flatPositions_of` layout behind them.

## 0.2.2

### Patch Changes

- 92cc3e8: Cleanup, slice 4: the flights a surface asked for as five scene calls round a flag of its own are the scene's words now (`scene/flights.ts`): `frame` (fly to hold nodes), `relight` (a graph held where it stands, part of it framed), `unfold` (nodes settle out from where others stood, the rest frozen, then framed) and `descent` (approach, ask the surface, unfold or stand down), with `moving()` saying whether one is under way. The placement adapters the hand-off and the tubes read live in `scene/drawn.ts`. Unit tests for the flights. No behaviour changes.
- c8ced3b: Cleanup, slice 3: the scene is composed of its parts. `Orrery` (one class of sixty-five methods in an 1,800-line file) now delegates to `scene/settle.ts` (the layouts placed in scene vectors), `scene/wave.ts` (the pulse wave), `scene/replayTrack.ts` (the replay over the star field), `scene/grab.ts` (a node pulled, the molecule's reaction, the ease home), `scene/hover.ts` (the tip and the pick), `scene/hierarchySettle.ts` (the worker protocol), `scene/bodies.ts` (one draw's bodies and edges) and `scene/drawn.ts` (where a drawn node stands); each part reads the scene through a small port and has its own unit tests. The public face is unchanged. `npm run lint:orrery` now also holds every orrery function under 150 lines and every file under 1,200. No behaviour changes.

## 0.2.1

### Patch Changes

- 74eb31e: In the 2D projection a node's disc is drawn on its tubes, not under them: the disc draws after the tubes without the depth test, as a sphere's near hemisphere covers a tube end in 3D.

## 0.2.0

### Minor Changes

- fbd3f0a: The session lays the universe out itself: once the index is whole the daemon runs orrery's engines for every layout in a worker thread and keeps the places (`proc layout <name>` reports `laying` progress meanwhile). orrery is published; `layoutInput_build` builds the engines' input one way for browser and session, and the universe graph builders live in `@fnndsc/menu`. ARGUS waits on the session's progress instead of settling the same space, keeps places only for the view on stage (SHAPES apart), redraws a view already seen where it stood, and gives the session only default-physics places.
