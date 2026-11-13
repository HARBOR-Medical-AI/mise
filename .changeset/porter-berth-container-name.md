---
"@fnndsc/porter": patch
---

A berth's container carries its person's name, so `docker ps` on a spoke says whose each berth is. The name is `<prefix>-<user>-<key>` (`mise-berth-rudolphpienaar-5547f8aaaf8cf914`), the user spelled as the berth's wire spells them; the key stays, so two identities whose user names are spelled alike, or one person on two CUBEs, have containers apart. The volumes and the wire keep their names, and with them each person's home and cohort data. A container under the name without the user (`<prefix>-<key>`) is still that person's berth: `status` reads it, it holds its place in the spoke's room and keeps its wire through the launcher's sweep, and the launcher stops and removes it when that person's berth is started or stopped, so nobody has two. `berthNames_derive` returns it as `containerLegacy`, and `berthName_matches` says whether a container's name is a berth's.
