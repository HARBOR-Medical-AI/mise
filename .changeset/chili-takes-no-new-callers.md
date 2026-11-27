---
"@fnndsc/chili": minor
"@fnndsc/brasa": patch
"@fnndsc/chell": patch
---

Two modules nothing used are gone from the deprecated chili package, and nothing new may start to depend on it.

How: `@fnndsc/chili` is being retired (its logic to salsa, its verbs to brasa's builtins, its rendering to the surfaces). Removed, because nothing in the repository calls them: `lfs/lfs` and `commands/pipeline/run` (both reachable only as subpaths through the package's `./*` export: `@fnndsc/chili/lfs/lfs.js`, `@fnndsc/chili/commands/pipeline/run.js`), and the unused `chris_pull` inside the path command. The `chili` command and every other subpath stay. brasa no longer initialises the ChRIS connection a second time through chili: there is one connection, initialised once. chell no longer lists chili as a dependency it does not import, and its help no longer says unknown words go "to the chili CLI". Two checks keep it so: `lint:chili` counts brasa's imports of chili against a baseline that may only fall (36 files, 85 imports) and fails an import from any other workspace; `lint:pack` checks that every published package's `main`, `types`, `bin` and `exports` lead to files it would publish.
