---
"@fnndsc/brasa": patch
---

A pipeline run from a plain folder roots a feed on it; download reads a /proc/jobs path; find by workflow reads the run's feeds alone; the scheduled run names its leaves' outputs.

Four of the six problems of a play that uploads a recording, runs a pipeline on it and downloads one node's output (#1364). A pipeline run from `/bin` with no operand, outside a feed node, now roots a new feed on the working directory with pl-dircopy and runs off it, as a plugin does and as the directory operand did; the scheduled model says `newFeed`. `download` of `/proc/jobs/feed_N/<node>/data` (and below) resolves through the same link `ls` and `cd` enter, to the run's output. `find /proc/jobs -workflow N` asks CUBE which feeds the run's jobs are in and reads those alone, instead of indexing every feed first. The scheduled model carries `leafPaths`, where the leaves write, so a play says `download ${RUN.leafPaths} <dir>`.
