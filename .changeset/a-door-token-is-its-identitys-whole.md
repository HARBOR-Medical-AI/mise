---
"@fnndsc/porter": minor
---

A door token now works only at a door for the CUBE it was minted for, and the door and the operator's commands never lose each other's token changes.

How: a token login took the username from the token and rebuilt the identity from the door's current CUBE, so a token could open a same-named person's session on another CUBE; the identity is now the token's own, and a token minted for another CUBE is refused before any cookie or session. A logout by token revokes the token presented, by its hash, not every token of that name. The store is now a folder of versions (`<PORTER_TOKENS_FILE>.d/`): each change is read afresh and published whole as the next version by an exclusive link, so a revocation can never be undone by a concurrent login and no mint is lost to a concurrent one; a token login is one such change, so a token revoked meanwhile is refused. Records of the wrong shape are left out and counted at start. A token's last use is written at most once an hour. The old one-file store is migrated at the first start and kept as `tokens.json.migrated`.
