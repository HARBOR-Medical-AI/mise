# @fnndsc/porter

PORTER is the mise display manager — gdm to ARGUS's desktop. It logs an operator into one CUBE, finds or starts their calypso session on this host, and shows their browser to ARGUS under `/s/<key>/`, holding the attach token so the browser never does.

Design log: [`docs/porter.adoc`](docs/porter.adoc).

```sh
PORTER_CUBE_URL=https://cube.example.org/api/v1/ porter
open http://localhost:4180/login          # the door: log in, land on the session
curl -s -c jar -X POST localhost:4180/login -H 'content-type: application/json' -d '{"username":"chris","password":"…"}'
curl -b jar -N localhost:4180/boot/<key>
```

```sh
npm install -g @fnndsc/porter        # brings chell, calypso and argus beneath it
PORTER_CUBE_URL=https://cube.example.org/api/v1/ porter
```

Or from the checkout: `make porter CUBE_URL=…`. Deployment (systemd, env file, Caddyfile) in [`deploy/`](deploy/).

Porter needs Linux. It holds its own folders open (the token store's, each session's) and reaches them through `/proc/self/fd`, so a folder put in place of one it checked is never read from or written into; on a host without that it refuses to start and says why.

## Berths

On a spoke, each person's session runs in a berth: their own container from the `mise-berth` image, started by the berth launcher, the one process that holds the container engine (`docs/dev-bastion.adoc`, stand-in). The launcher is this package's second program:

```sh
BERTH_LAUNCHER_SECRET_FILE=/etc/mise/launcher.secret \
BERTH_LAUNCHER_LISTEN=/run/mise/launcher.sock \
berth-launcher
```

It reads `BERTH_DOCKER_SOCKET` (`/var/run/docker.sock`), `BERTH_IMAGE` (mise-berth's `latest`), `BERTH_PREFIX` (`mise-berth`), `BERTH_CUBE_NETWORK` (`<prefix>-cube-net`), `BERTH_PORTER_CONTAINER` (porter's container, when porter is one; unset when porter runs on the host), `BERTH_POLICY_FILE` (JSON: `cpus`, `memoryGib`, `pids`, `holds`) and `BERTH_PROFILE` (`minimal`). Its API, for porter alone and carrying the secret, is start, stop and status of a person's berth; a start names the cohort (a feed's id) `/incoming` and `/outgoing` are for, or none.

The wires are `docs/berths.adoc`'s topology: each berth hangs off porter on a bridge of its own, `<prefix>-net-<user>`, made when the berth starts and removed when it stops, porter's container joined to it and taken off it (a porter on the host reaches the bridge as it is); every berth also stands on cube-net, a bridge that blocks traffic between its containers and carries only the CUBE API, which the berth reaches at the address the spoke publishes it on (cube-net's gateway, or the public name). A launcher starting removes what an earlier run left: helpers, and wires with no berth on them.

The volumes: one home per person (`/home/<user>`, for life), and one volume per person and cohort holding `incoming/` and `outgoing/`, mounted at `/incoming` (read-only) and `/outgoing`; a start with another cohort makes the berth again on that pair and the home stays; none is a pair of its own, `…-cohort-none`.

The image is one constant, `BERTH_IMAGE_DEFAULT` in `src/launcher/launcher.ts`: `ghcr.io/harbor-medical-ai/mise-berth:latest`, the tag the Berth image workflow moves at every build on main (`images/mise-berth/README.md`). Nothing is pinned. The launcher pulls the image before it makes a berth from it, so a berth made after the tag moved runs the newer image with no redeploy; a berth already running is handed back as it is. A pull that fails (the registry away, no answer in two minutes) is one line in the launcher's log and the berth is made from the copy the host holds; with no copy the start is refused, saying why.

A porter starts sessions in berths when the deployment says so; without it, it starts them beside itself, as processes of porter's own account. Such a session is given an environment built from a list (`src/host/sessionEnv.ts`), never porter's own: `PORTER_SECRET` and every other `PORTER_` name, the operator's credentials and agents, `NODE_OPTIONS`, and any proxy or door address that could carry a credential stay with porter, and porter names at start, by name only, an address it withheld. Each session has its own home, state, data, config, cache, runtime and temporary folders under porter's state, each a real folder of porter's account left 0700 at every start; one that is a link, another account's or outside porter's state refuses the start. They are made through the session folder held open (`/proc/self/fd`). A session beside porter has no host control whatever porter's environment says (`CALYPSO_HOST_CONTROL` is not passed on): it never reaches the host's shell, disk or pipes; a stratus session armed for spending runs host tasks, and nothing else.

In berths:

```sh
PORTER_BERTHS=launcher PORTER_LAUNCHER=/run/mise/launcher.sock PORTER_LAUNCHER_SECRET_FILE=/etc/mise/launcher.secret porter
```

At a login it reads the person's CUBE id with their token, asks the launcher for their berth (uid and gid that id), and shows the berth's calypso through the door; a later login's token reaches the berth already up; a logout stops the berth and keeps its volumes. The secret file is mode 0600, and the launcher refuses one any other user can read.

The operator reads every person's berth with `GET /berths`, asked with `Authorization: Token <CUBE token>` or the admin's Basic credentials:

```sh
curl -s -u chris:… https://porter.example.org/berths
# {"at":"2026-11-09T10:00:00.000Z","berths":[{"user":"ana","state":"running","cohort":"none","cpuPercent":3,"memoryBytes":220200960,"memoryLimitBytes":2147483648},{"user":"benito","state":"stopped","cohort":null,"cpuPercent":null,"memoryBytes":null,"memoryLimitBytes":null}]}
```

porter hands the credentials to CUBE's API root and answers only a CUBE administrator (the root names its `admin` link to an administrator alone): 401 with no credentials or ones CUBE refuses, 403 for a CUBE user who is not an administrator, 502 when CUBE (or a redirect from it) or the launcher does not answer. A client address may ask ten times a minute; past that is a 429 with `Retry-After`, and CUBE is not asked. CUBE's verdict on one `Authorization` header (never the credentials; kept under its sha256) is remembered for 30 s. A running berth carries one sample of its CPU (a percent of one CPU) and memory; a stopped one is a person whose home volume stays; a person with neither is absent. The launcher reads the berths over its local API (`GET /berths/access?cubeUrl=…`), so porter never touches the container engine; it shows the people of this porter's CUBE only, by identity, so a berth or home left by an earlier CUBE URL is not shown, and a berth the engine does not sample within 3 s is running with its usage unread. A porter that starts no berths (`PORTER_BERTHS` unset) answers `{"berths": null, "why": "this porter starts no berths"}`, which stratus and ARGUS take as an answer (`berths are off`) and not a failed read. stratus reads this for `chris status`, and ARGUS shows it as HOST ACCESS in ITS USERS.

## Door tokens

A door token belongs to one whole identity, the CUBE included: a token minted for `kim` at one CUBE is refused at a door that serves another, and its logout (`chell auth logout`, by the token in hand) ends that token alone, never a replacement of the same name. A device login renews the token for its host: the token already held stands until chell's poll takes the new one, so an approval chell never collects leaves the old token working. The store is a folder of versions beside the file it is named by (`<PORTER_TOKENS_FILE>.d/`, versions filed in folders of a thousand, every folder 0700 and every version 0600): every change writes the next version whole and publishes it with an exclusive link, so the running door and the operator's `porter --mint`, `--revoke` and `--tokens` never lose each other's changes, and a revocation is seen at the token's next use. Every folder is opened without following a link and shown to be porter's own before anything in it is read or made, and every file is read the same way; the store's I/O runs off the door's event loop. Old versions are emptied, never removed, and the highest version published is marked beside the store's file (`<PORTER_TOKENS_FILE>.marks/`, one name per version, never lowered): a read that finds less refuses rather than answer from an older store. One limit stands: if the mark for a version cannot be written (porter says so at once, and the CLI on stderr) and, before the next start writes it, porter's own account deletes the newest folder of versions, the folder before it answers; the next start writes the mark only while the version it names is still there. A token's last use is sampled at most once an hour. A one-file store from before is migrated into the first version at the first open and left where it is, untouched; porter says at start if it changed after the migration (an older porter wrote it), since the versions are the store.

## Door cookies

A door cookie is worth the grant the door keeps for it. The cookie names a session key and a grant, signed with `PORTER_SECRET`; the door keeps its grants in `door-grants.json` in its state (0600, written through a fresh file renamed in), so a restarted porter honours the grants it made and no other. A grant is made only by a login or a switch that succeeds, lives `PORTER_COOKIE_HOURS`, and ends at that browser's logout, at a switch away from it, or at its hour: then the cookie lets nobody in however well it is signed, and every connection opened under it is closed at that moment (a WebSocket with 4401 "signed out" at a frame boundary, a boot stream by ending it), traffic or none. Two browsers of one person hold grants of their own; one's logout leaves the other's. A logout refuses its cookie the moment it is asked; if the door cannot write that down it answers 503 and the same cookie may log out again (it is refused meanwhile); a logout on a cookie a switch had already moved answers 409 and leaves the switch's cookie. A login sets its cookie, and settles a named token it asked for, only when it succeeds: a login that fails leaves no grant and costs no standing token. A logout keeps its effect on the session: in berth mode the person's berth stops, beside porter the session runs until idle. The berth is stopped by the one logout that ended the grant, in that request, even when its write fails (the 503 says whether the berth stopped); the retry that writes the end stops nothing. A logout stops what it arrived to: the session that stood then, or, behind a restart under way, the berth that restart leaves running; a berth a restart started in place of the one a logout arrived to is left. A logout whose write failed is refused for good only in the running porter: restarted before the retry, the door reads the grant from its file again. When the launcher cannot say which berth is up (the engine did not list its containers, or a running berth's address could not be read), such a stop is said as not made: the berth may still be up. A start refuses rather than count the berths up as none. A cookie from before grants is no longer let in: every browser signs in once after the upgrade.

