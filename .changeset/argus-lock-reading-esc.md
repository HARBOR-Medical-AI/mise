---
"@fnndsc/argus": patch
---

The TD controller shows READING after a line while the tenancy is searched; Escape over the password sheet closes the sheet only.

After LIFT THE LOCK or LOCK AGAIN the daemon searches the tenancy before the lock's new state shows, which takes seconds on a real cloud; the controller now logs the read, shows READING under SINCE LAST COMMAND and on the TEARDOWN seat, instead of a dead pill. Escape with the MANAGE password sheet up was taken by the controller, which closed and left the sheet stranded over the dashboard; the sheet now takes it (NOT NOW). Where a daemon has no door, a held control says so instead of "press again".
