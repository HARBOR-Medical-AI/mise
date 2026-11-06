---
"@fnndsc/salsa": patch
---

plugin validate refuses a blank or overlong name, version, image, execshell, selfpath or selfexec, as CUBE does. An empty `selfpath` passed validation and was then refused by CUBE 6.11.0 ("This field may not be blank."); rule 2 now holds the text descriptors to CUBE's own model limits.
