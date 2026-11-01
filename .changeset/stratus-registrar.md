---
"@fnndsc/stratus": minor
---

`chris deploy --host` points the name at the VM itself when the zone is kept at GoDaddy. When public DNS does not yet give the name the VM's address and the zone's name servers are GoDaddy's, it reads the name's records through GoDaddy's v3 API with the token kept in `~/.config/stratus/godaddy`, says what it would change (`remove CNAME cube → …, add A cube → <address> (TTL 600)`) and asks; on yes it makes the change, then waits for public DNS and the certificate as before. Without the token, or for a zone kept elsewhere, it says where to point the name by hand.
