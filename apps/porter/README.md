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

## Berths

On a spoke, each person's session runs in a berth: their own container from the `mise-berth` image, started by the berth launcher, the one process that holds the container engine (`docs/dev-bastion.adoc`, stand-in). The launcher is this package's second program:

```sh
BERTH_LAUNCHER_SECRET_FILE=/etc/mise/launcher.secret \
BERTH_LAUNCHER_LISTEN=/run/mise/launcher.sock \
berth-launcher
```

It reads `BERTH_DOCKER_SOCKET` (`/var/run/docker.sock`), `BERTH_IMAGE` (mise-berth pinned by digest), `BERTH_PREFIX` (`mise-berth`), `BERTH_CUBE_NETWORK` (`<prefix>-cube-net`), `BERTH_PORTER_CONTAINER` (porter's container, when porter is one; unset when porter runs on the host), `BERTH_POLICY_FILE` (JSON: `cpus`, `memoryGib`, `pids`, `holds`) and `BERTH_PROFILE` (`minimal`). Its API, for porter alone and carrying the secret, is start, stop and status of a person's berth; a start names the cohort (a feed's id) `/incoming` and `/outgoing` are for, or none.

The wires are `docs/berths.adoc`'s topology: each berth hangs off porter on a bridge of its own, `<prefix>-net-<user>`, made when the berth starts and removed when it stops, porter's container joined to it and taken off it (a porter on the host reaches the bridge as it is); every berth also stands on cube-net, a bridge that blocks traffic between its containers and carries only the CUBE API, which the berth reaches at the address the spoke publishes it on (cube-net's gateway, or the public name). A launcher starting removes what an earlier run left: helpers, and wires with no berth on them.

The volumes: one home per person (`/home/<user>`, for life), and one volume per person and cohort holding `incoming/` and `outgoing/`, mounted at `/incoming` (read-only) and `/outgoing`; a start with another cohort makes the berth again on that pair and the home stays; none is a pair of its own, `…-cohort-none`.

The image pin is one constant, `BERTH_IMAGE_DEFAULT` in `src/launcher/launcher.ts`, beside the hash of `images/mise-berth`'s source it was built from; `npm run lint:berth-pin` fails when the source changed and the pin did not. A branch that changes the image is built and pushed by the Berth image workflow as soon as it is pushed; its run summary names the digest, and `node images/mise-berth/pin.mjs <image@sha256:…>` moves the pin and records the source, which is the commit that makes the branch mergeable.

A porter starts sessions in berths when the deployment says so; without it, it starts them beside itself:

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
