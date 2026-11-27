---
"@fnndsc/porter": minor
---

A session the door starts is no longer given its cookie-signing key, the rest of its environment, or host control.

How: porter used to start each local session with the whole of its environment, which held `PORTER_SECRET`; a session's shell expands `${NAME}` from its environment, so anyone signed in could read the key and sign a cookie for another person. A session is now given only the names on a list (`src/host/sessionEnv.ts`): the path, account, locale, terminal, editor, certificate and proxy settings it needs, and three daemon settings. No `PORTER_` name reaches it, nor `NODE_OPTIONS`, nor a proxy or door address carrying a user, password, query or fragment (porter names those at start). `CALYPSO_HOST_CONTROL` is no longer passed on: a session beside the door has no host shell, disk or pipes, and only a stratus session armed for spending runs host tasks. Every session also has a home, state and data folder of its own, so chell's history is the person's, not shared; history kept in the shared folder before this does not carry over. After upgrading, restart sessions started before it and rotate `PORTER_SECRET`.
