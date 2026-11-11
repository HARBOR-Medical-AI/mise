---
"@fnndsc/stratus": minor
---

A ChRIS deploy with a porter always installs the latest published porter; no porter version is pinned in stratus. `chris deploy --porter` installs `@fnndsc/porter@latest` into `stratus/porter:latest`, built on the VM without Docker's layer cache, so every deploy takes the release npm names at that moment, with the calypso, chell and ARGUS it brings. The version installed is read back from the built image and kept in the record as `porterVersion`, which `chris status` shows. Because each such deploy rebuilds porter, its plan always names the restart (`porter (rebuilt from the latest release; <version> runs now): its open sessions end`) and asks first. The image a newer build replaced is removed once nothing runs from it. With berths, the berth image porter names is a tag (`mise-berth:latest`), no longer required to be by digest, and is pulled at every deploy. `PORTER_VERSION` is gone from `chris/profiles`; `PORTER_DIST_TAG` names the npm dist-tag.
