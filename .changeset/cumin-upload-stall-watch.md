---
"@fnndsc/cumin": patch
---

A large upload to CUBE is no longer failed at 30 s. It fails only when it has made no progress for two minutes, and says how far it got. The file is posted over fetch, which reads it only as the connection takes its bytes, so a slow upload that keeps moving runs to its end; one that stops is abandoned with `CUBE stopped taking <name> after n of m bytes (nothing for 120 s)`, `CUBE took none of the m bytes of <name> for 120 s`, or `CUBE took all m bytes of <name> and did not answer for 120 s`.
