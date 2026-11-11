---
"@fnndsc/porter": minor
---

A berth always starts from the latest berth image, which the launcher pulls before it makes one. `BERTH_IMAGE_DEFAULT` is `ghcr.io/harbor-medical-ai/mise-berth:latest`, a tag the Berth image workflow moves at every build on main, and `BERTH_IMAGE_SOURCE` is gone with the digest pin it recorded. Before the launcher makes a berth from the image (never when it hands back one already running) it asks the engine to pull it, so a moved tag is followed with no redeploy. A pull that fails, or gives no answer in two minutes, is one line in the launcher's log and the berth is made from the copy the host holds; with no copy the start is refused, saying why. The image itself is built from the calypso and chell latest on npm, and `make deploy` builds it on main after each publish.
