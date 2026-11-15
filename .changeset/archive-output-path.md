---
"@fnndsc/brasa": patch
"@fnndsc/salsa": patch
---

Downloading a folder from the browser delivers its zip again, instead of failing with "produced no file".

A browser has no folder to fill, so `download` of a folder from ARGUS runs the zip pipeline and hands over the one file it makes. The archive was looked for at `feeds/feed_N/pl-dircopy_M`, a path built from ids, but CUBE keeps a feed under its owner's home (`home/<user>/feeds/feed_N/…`), so the listing found nothing and every such download failed after the pipeline had run, leaving its feed behind. The archive is looked for in the archive job's output folder as CUBE records it (`output_path`, read by salsa's new `job_outputPathFetch`), and is handed over at its absolute path.
