---
"@fnndsc/brasa": patch
"@fnndsc/salsa": patch
---

Files behind /proc data links and .chrislinks open in image, gather, record, query --csv-to and a delivered file.

Each of these found its path in CUBE without the one store-path resolver, so a path through a `pl-dircopy` link, or under a `/proc/jobs/…/data` path, was read or written at the wrong place. They ask `storePath_resolve`, as the file commands do: `image` reads a series behind a link; `gather` takes a `/proc` job's `data` folder as a folder, not a file; `query --patients @file` reads, and `--csv-to` writes, where the store keeps the path; so do the gather cohort, a `record` manifest and a file a surface delivers. `xxd`, `strings`, `sha256sum` and `md5sum` read through the same resolver instead of chili's link mapper, and still name the path as typed. `dcm` and `expect … tags` ask `storePath_resolve` directly; `dcm`'s `path_physical` wrapper is gone. A new check, `npm run lint:store-paths`, holds the rule in the source: above the store every call that reaches CUBE's files by path asks the resolver, or says it is handed a store path; no mount reads the store itself; and the dispatcher's one path resolver is `storePath_resolve`.
