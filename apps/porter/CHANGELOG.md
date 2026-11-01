# @fnndsc/porter

## 0.9.3

### Patch Changes

- Updated dependencies [f6790b6]
- Updated dependencies [da946ab]
- Updated dependencies [f6790b6]
- Updated dependencies [68e0136]
- Updated dependencies [8183f6c]
- Updated dependencies [b227791]
  - @fnndsc/menu@0.32.0
  - @fnndsc/stratus@0.7.0
  - @fnndsc/chell@5.19.9
  - @fnndsc/calypso@0.28.3
  - @fnndsc/cumin@3.29.5

## 0.9.2

### Patch Changes

- Updated dependencies [9a58e99]
  - @fnndsc/stratus@0.6.0
  - @fnndsc/chell@5.19.5

## 0.9.1

### Patch Changes

- Updated dependencies [6323634]
- Updated dependencies [f086bc6]
- Updated dependencies [4568c64]
- Updated dependencies [4568c64]
  - @fnndsc/stratus@0.5.0
  - @fnndsc/calypso@0.28.1
  - @fnndsc/menu@0.31.1
  - @fnndsc/chell@5.19.4

## 0.9.0

### Minor Changes

- 0efbb7c: A PULL in ARGUS runs in the background: the console and every other press stay yours while a retrieve goes on. The press sends `pull … &`; the badges follow it as before, each running joblet is a row on the LANE instrument with a STOP that types `kill %N`, the console prints when one starts, ends or waits for an answer, and RESTART names the joblets it would end (#1273).

  A joblet relays its progress, and any model it answers with, to the surface it came from; its task carries its progress. The heartbeat's lane lists the running joblets, calypso answers `GET /joblets` (token-gated), and a porter login that finds a session on older code keeps it, rather than restart it, while joblets run.

### Patch Changes

- Updated dependencies [41769da]
- Updated dependencies [0efbb7c]
- Updated dependencies [b8bc519]
- Updated dependencies [56debd5]
  - @fnndsc/calypso@0.28.0
  - @fnndsc/menu@0.31.0
  - @fnndsc/chell@5.19.2
  - @fnndsc/stratus@0.4.3
  - @fnndsc/cumin@3.29.3

## 0.8.0

### Minor Changes

- 02c20bf: Every function name now says what it does: the 462 that put a preposition where the verb goes are renamed (#1227).

  The style guide names a function `<subject>[Qualifier]_<verb>[Adverb]`. Names such as `answerRows_of`, `seriesUID_ofPath`, `options_toParams` and `ask_onPane` put a preposition in the verb's place, which names the result without saying whether the function derives, parses, builds or renders it. They are now `answerRows_derive`, `seriesUID_parse`, `options_convertToParams` and `askOnPane_await`. A preposition may still qualify the verb (`x_readFromCache`) or the object (`askOnPane_await`); it may not start the method.

  `npm run lint:rpn` (`scripts/rpn-prepositions.mjs`) refuses a function, `const` function or underscored method whose method is, or starts with, `of`, `to`, `with`, `from`, `for`, `by`, `as`, `in`, `on` or `at`, and CI runs it. The exported names change with no aliases kept: nothing outside this repository imports them.

### Patch Changes

- Updated dependencies [f27596d]
- Updated dependencies [a61f844]
- Updated dependencies [fd1711f]
- Updated dependencies [68d496d]
- Updated dependencies [4bc9d87]
- Updated dependencies [02c20bf]
- Updated dependencies [55e2041]
- Updated dependencies [5731276]
  - @fnndsc/stratus@0.4.0
  - @fnndsc/menu@0.30.0
  - @fnndsc/calypso@0.27.0
  - @fnndsc/chell@5.19.0
  - @fnndsc/cumin@3.29.0

## 0.7.0

### Minor Changes

- 682f713: One login reaches your cloud too: `stratus oci` switches a ChRIS session to your stratus one, and `chris` comes back. The porter starts or rejoins it on the OCI key filed under the person's ChRIS identity (`porter --creds <user> --oci <config>`, run on the host), in a home and state of its own, read-only unless `stratus oci --spend` is asked for with `spend` typed; it restarts on the same tier and is adopted after a porter restart. No one reaches another's tenancy through the door (stratus.adoc D14).

### Patch Changes

- 46bc80d: Zod moves to 4.6.7: zod 3 carries a high-severity advisory with no 3.x fix, which failed every build's audit. The advisory is GHSA-mrhx-c7xc-m3w5, memory exhaustion while validating oversized constrained collections. The wire schemas read as before: `.catch` fallbacks, `.default` values, `.passthrough()` and the recursive DICOM tag parse were checked against zod 4. `dicomTagSchema` is typed `z.ZodType<DicomTag, unknown>`; schemas exported from `@fnndsc/menu` are zod 4 schemas, so code that names zod 3's types against them (`ZodTypeDef`, `SafeParseReturnType`) has to move too. A boundary reason now renders a symbol in a path instead of throwing. salsa's nested lockfile, which only the audit reads, overrides zod until a `@fnndsc/menu` built on zod 4 is published, and is back in step with salsa's `package.json`.
- Updated dependencies [a1a7fc5]
- Updated dependencies [e1d052d]
- Updated dependencies [b4cd618]
- Updated dependencies [52b9691]
- Updated dependencies [9b328dc]
- Updated dependencies [05ec948]
- Updated dependencies [dd0b518]
- Updated dependencies [46bc80d]
  - @fnndsc/stratus@0.3.0
  - @fnndsc/menu@0.29.0
  - @fnndsc/chell@5.18.1
  - @fnndsc/calypso@0.26.2
  - @fnndsc/cumin@3.28.6

## 0.6.15

### Patch Changes

- Updated dependencies [0388f12]
- Updated dependencies [49ccdfd]
- Updated dependencies [49ccdfd]
- Updated dependencies [ca1ba5b]
- Updated dependencies [49501d4]
- Updated dependencies [49501d4]
- Updated dependencies [49501d4]
- Updated dependencies [14f8fc1]
- Updated dependencies [dcdc6cd]
- Updated dependencies [540b477]
  - @fnndsc/chell@5.17.0
  - @fnndsc/calypso@0.26.0
  - @fnndsc/menu@0.28.0
  - @fnndsc/cumin@3.28.4

## 0.6.14

### Patch Changes

- 5cdc0c8: ARGUS has a voice: every sound synthesized in the browser from a spectral model, and the trek bridge heard by rule.

  A cue is a compact spectral resynthesis of a reference clip (partial tracks and noise bands), played through Web Audio; no recording ships. The bank names a cue for each of the game's events and one computer beep for each of the bridge's pills: a pill that only opens, sets or answers beeps, a pill that does something is heard as the thing, and the alerts, hits, kills and docking are heard from what the engine shows and says. The frame's own four beeps go through the same voice; a deployment that keeps recordings of its own still hears them, because the porter now names its sounds folder's files at `sounds/index.json`. The audio pill is the one mute. The analysis tooling that makes a model from a clip is in `tools/trek-sound`.

  - @fnndsc/chell@5.16.5

## 0.6.13

### Patch Changes

- Updated dependencies [21649d1]
  - @fnndsc/menu@0.27.0
  - @fnndsc/calypso@0.25.0
  - @fnndsc/chell@5.16.4
  - @fnndsc/cumin@3.28.2

## 0.6.12

### Patch Changes

- Updated dependencies [c1ad144]
- Updated dependencies [5dadfdd]
- Updated dependencies [fb6813d]
  - @fnndsc/calypso@0.24.0
  - @fnndsc/chell@5.16.0
  - @fnndsc/menu@0.26.0
  - @fnndsc/cumin@3.27.19

## 0.6.11

### Patch Changes

- Updated dependencies [66f1956]
- Updated dependencies [66f1956]
  - @fnndsc/chell@5.15.0
  - @fnndsc/menu@0.25.0
  - @fnndsc/calypso@0.23.1
  - @fnndsc/cumin@3.27.17

## 0.6.10

### Patch Changes

- Updated dependencies [90b7688]
- Updated dependencies [554fd24]
- Updated dependencies [6bde343]
- Updated dependencies [7645d3c]
  - @fnndsc/calypso@0.23.0
  - @fnndsc/chell@5.14.0
  - @fnndsc/menu@0.24.0
  - @fnndsc/cumin@3.27.15

## 0.6.9

### Patch Changes

- Updated dependencies [c73c81b]
- Updated dependencies [1a2a0d0]
- Updated dependencies [0746967]
- Updated dependencies [0820af7]
  - @fnndsc/calypso@0.22.0
  - @fnndsc/menu@0.23.0
  - @fnndsc/chell@5.13.0
  - @fnndsc/cumin@3.27.14

## 0.6.8

### Patch Changes

- Updated dependencies [3c8d56a]
  - @fnndsc/calypso@0.21.0
  - @fnndsc/chell@5.12.1

## 0.6.7

### Patch Changes

- 639b840: ARGUS over a backend other than ChRIS shows the frame alone: files, the console and its own tiles (#985). Before it builds, ARGUS asks the daemon `GET /backend` (token-gated; porter adds the token behind a door) and installs the ChRIS composition only for ChRIS; an older daemon is ChRIS. What ChRIS owns in the page's markup carries `data-composition`, and a saved ChRIS preset falls back to home. The FILES tile's description is the composition's (ChRIS keeps its own words). The smoke stage `frame-alone` checks both sides.
- Updated dependencies [639b840]
- Updated dependencies [183aa7d]
- Updated dependencies [43000d3]
- Updated dependencies [e1085af]
- Updated dependencies [b9a83f1]
- Updated dependencies [27f3021]
- Updated dependencies [9116e97]
- Updated dependencies [0ac1bee]
- Updated dependencies [6752575]
  - @fnndsc/calypso@0.20.0
  - @fnndsc/menu@0.22.0
  - @fnndsc/chell@5.12.0
  - @fnndsc/cumin@3.27.11

## 0.6.6

### Patch Changes

- Updated dependencies [8d15909]
  - @fnndsc/menu@0.21.0
  - @fnndsc/calypso@0.19.10
  - @fnndsc/chell@5.11.4
  - @fnndsc/cumin@3.27.10

## 0.6.5

### Patch Changes

- Updated dependencies [5bb17f6]
  - @fnndsc/menu@0.20.0
  - @fnndsc/chell@5.11.3
  - @fnndsc/cumin@3.27.9
  - @fnndsc/calypso@0.19.9

## 0.6.4

### Patch Changes

- eb43996: The door and the daemon now say their version, through `porter --version` and `calypso --version` (or `-V`). porter prints its own version and the brasa, calypso and chell it would start sessions on; calypso prints its stack, as `chell --version` does.
- Updated dependencies [eb43996]
  - @fnndsc/calypso@0.19.8

## 0.6.3

### Patch Changes

- df34da0: A failed login now says what failed, instead of always blaming the credentials. An untrusted TLS certificate names the host, the code and `NODE_EXTRA_CA_CERTS`; an unreachable CUBE says so with the code; only CUBE refusing the login mentions the password. The same holds for token logins, `sudo`, and porter's login page.
- 563d788: porter installed from npm now starts instead of exiting silently. That covers its `porter` bin link, `npx porter` and `node_modules/.bin/porter`. It used to decide whether it was the program by checking that `argv[1]` ended in `porter.js`; it now compares real paths, as chell and calypso do.
- Updated dependencies [d3618fb]
- Updated dependencies [df34da0]
  - @fnndsc/chell@5.11.2
  - @fnndsc/cumin@3.27.7
  - @fnndsc/calypso@0.19.7

## 0.6.2

### Patch Changes

- 3538728: A restart now says why in plain words, naming the packages a stale daemon was behind. `Restarting a stale calypso daemon (brasa 0.31.5 → 0.33.0)` replaces "the old one is told why and ended"; RESTART reads `Restarting the calypso daemon, as asked`.

## 0.6.1

### Patch Changes

- 6325bc4: The door has a page to type a chell code at. `/device` puts a code field beside the username and password, as github.com/login/device does, and authorising a code also starts the user's session when none is up, so a first-ever `chell auth login` is followed by a `chell -c` that works.
- Updated dependencies [6325bc4]
  - @fnndsc/chell@5.11.1

## 0.6.0

### Minor Changes

- 5c16c65: The door takes a token as well as a password, so a script can come through without one. A human login can mint a named door token (a JSON login asking for one, or the browser authorising a chell by one-time code on the login page); the door keeps only its hash, with the name and the day it dies (`PORTER_TOKEN_DAYS`, 30 by default), and a script presents it as `Authorization: Bearer`. A session not up boots on the login it saved. Expired and unknown tokens are refused by name, and the journal says who came through by which token.
- 44c75f4: The porter's own command line lists, revokes and mints door tokens. `porter --tokens` shows user, name, minted, dies and last used; `porter --revoke <user> [<name>]` ends one or all of a user's; `porter --mint <user> --name <name>` mints one by the operator's hand, shown once, for a service identity or a hand-over. A running door notices a store changed under it on the token's next use, so a revocation takes effect without a restart.

### Patch Changes

- b4a7674: A holder can see and end their own door tokens. A token login answers whose token it was; `GET /auth/tokens` lists the identity's tokens by one of them and `DELETE /auth/token` revokes the token in hand, which is what `chell auth tokens` and `chell auth logout` call.
- Updated dependencies [b4a7674]
- Updated dependencies [8ae54c6]
- Updated dependencies [eea6238]
  - @fnndsc/chell@5.11.0

## 0.5.5

### Patch Changes

- 66bfa85: A login onto an older daemon restarts it the way the RESTART pill does. The old daemon is told why and waited out before the new one boots, so a terminal attaches to the new session rather than a port that is closing; and the door now reads the versions a berth carries, so a session restarted once is current and is not restarted again.

## 0.5.4

### Patch Changes

- 9f4c181: A login never lands on a kernel older than the door's. A session whose daemon still runs code from before the porter's last upgrade is ended at login and boots afresh on the way in, its saved state kept, so the first command you type is answered by the release that is installed.
- Updated dependencies [9f4c181]
  - @fnndsc/calypso@0.19.6

## 0.5.3

### Patch Changes

- a4aabb7: A word the porter entry does not know is refused by name instead of starting a second door. `porter --help` lists the words, `--sessions` says what `--status` says, and a restarted porter adopts the sessions it finds only once it holds its port.

## 0.5.2

### Patch Changes

- 5a0eef5: The package ships its release notes, so a session can say what changed. They are read from CHANGELOG.md at build into dist/notes.json.
- Updated dependencies [5a0eef5]
- Updated dependencies [5a0eef5]
- Updated dependencies [5a0eef5]
  - @fnndsc/calypso@0.19.4
  - @fnndsc/chell@5.10.3
  - @fnndsc/menu@0.19.0

## 0.5.1

### Patch Changes

- Updated dependencies [73c0087]
  - @fnndsc/menu@0.18.0
  - @fnndsc/calypso@0.19.2
  - @fnndsc/chell@5.10.1

## 0.5.0

### Minor Changes

- 33e4f1d: A session restarts from its own browser and stays logged in. Porter's new `POST /restart` (cookie-gated: only the cookie's own session) tells the old calypso daemon why, ends it, and boots a fresh one with chell's new `--saved-token` login, which uses the token the identity saved and refuses rather than come up offline. The browser follows the boot on the greeter; a refused saved token ends at the door with the reason. On SIGTERM the daemon sends `closing` (restart, end or stop) to every surface before it exits, and a remote chell prints why it went. `porter --end` leaves `end` as the reason.

### Patch Changes

- Updated dependencies [51315ec]
- Updated dependencies [33e4f1d]
- Updated dependencies [fe4b6b4]
  - @fnndsc/calypso@0.19.0
  - @fnndsc/menu@0.17.0
  - @fnndsc/chell@5.10.0

## 0.4.6

### Patch Changes

- Updated dependencies [685ed59]
  - @fnndsc/calypso@0.18.0
  - @fnndsc/menu@0.16.0
  - @fnndsc/chell@5.9.8

## 0.4.5

### Patch Changes

- Updated dependencies [2826f2b]
- Updated dependencies [c1cf57e]
- Updated dependencies [51da853]
  - @fnndsc/menu@0.15.0
  - @fnndsc/calypso@0.17.0
  - @fnndsc/chell@5.9.7

## 0.4.4

### Patch Changes

- 88437cc: A tab icon: the ChRIS mark on the page's own ground, for the surface and for the door.
- Updated dependencies [4864a34]
  - @fnndsc/menu@0.14.0
  - @fnndsc/calypso@0.16.10
  - @fnndsc/chell@5.9.6

## 0.4.3

### Patch Changes

- b5bb197: The greeter settles a boot row where it stands: the outcome of a `[PENDING]` or `[RETRY]` step replaces that row instead of appending beneath it.

## 0.4.2

### Patch Changes

- cbd71cc: A refused file read says why: the kernel names the status and reason (403 not yours to read, 404 no such file, 502 CUBE could not serve it), `/vfs` answers with them instead of 404 for everything, and an image pane that lost a slice reads the reason out. `porter --end <who>` ends one session so the next login boots on the current kernel.
- Updated dependencies [cbd71cc]
  - @fnndsc/calypso@0.16.9

## 0.4.1

### Patch Changes

- ef542cd: `PORTER_SOUNDS_DIR` actually answers: the mount hands the route `/sounds/press.mp3` with its leading slash, which the sound match did not allow, so every sound was proxied to the page's own. Route-level test added.

## 0.4.0

### Minor Changes

- c6d8161: `PORTER_SOUNDS_DIR`: a folder of sounds the porter serves in place of the page's own (`/s/<key>/sounds/<name>.mp3|wav|ogg`, bare names only), so a deployment's original LCARS beeps — never in a package — live outside the install and survive an upgrade.

## 0.3.5

### Patch Changes

- Updated dependencies [fbd3f0a]
- Updated dependencies [fbd3f0a]
  - @fnndsc/menu@0.13.0
  - @fnndsc/chell@5.9.5
  - @fnndsc/calypso@0.16.8

## 0.3.4

### Patch Changes

- Updated dependencies [f571a14]
- Updated dependencies [d1da8ac]
- Updated dependencies [0f9ae74]
- Updated dependencies [d8e160c]
  - @fnndsc/chell@5.9.4
  - @fnndsc/menu@0.12.0
  - @fnndsc/calypso@0.16.7

## 0.3.3

### Patch Changes

- 98b839f: A session whose daemon died is no longer proxied to the dead port: a login that boots a new daemon replaces the stale entry, and a mount whose daemon does not answer follows the session to its new berth or sends the browser to the door, instead of a bare 500 ECONNREFUSED.

## 0.3.2

### Patch Changes

- 05b9b41: porter: `porter --status` marks the pid on a gone row as stale. The berth outlives a daemon killed with -9, and the bare number read as a process the listing had just made.
  - @fnndsc/calypso@0.16.2

## 0.3.1

### Patch Changes

- Updated dependencies [dac2d96]
- Updated dependencies [dac2d96]
- Updated dependencies [50f8a4e]
- Updated dependencies [c82f514]
  - @fnndsc/chell@5.9.1
  - @fnndsc/menu@0.11.0
  - @fnndsc/calypso@0.16.1

## 0.3.0

### Minor Changes

- b58f4da: porter: published. `npm install -g @fnndsc/porter` brings the whole stack beneath it, and `PORTER_CUBE_URL=… porter` is the full login experience from one install. `@fnndsc/menu` is a declared dependency, since the greeter serves its brain and ANSI modules from where menu is installed.

### Patch Changes

- 2b18178: porter: `porter --status` asks for nothing but the state directory. It read the full configuration first and refused without `PORTER_CUBE_URL`, a fact a listing never uses.

## 0.2.0

### Minor Changes

- 3a8cd1b: A porter at the door: the mise display manager, slice 3 — the shape without the door.

  `apps/porter` logs an operator into one CUBE, trades the password for a token, starts or joins that identity's calypso (`chell --daemon --auth-token-stdin`, the token on stdin, four directories of its own under the porter's state) and mounts the session at `/s/<key>/`: page, assets, `/vfs` and the WebSocket wire proxied to the daemon on loopback with the attach token added by the porter, so the browser holds none. `GET /boot/<key>` streams the session's boot as server-sent events, one per line the daemon wrote, replayed for a late attacher. `POST /sessions` re-checks the password at CUBE every time, even when the session is up.

  calypso: the attach token may ride the upgrade URL (`?token=`), the way `/vfs?token=` already does, so a front that holds the token for a browser can put it on the proxied upgrade and the page attaches with an empty one; and `berth_pathIn(runtimeDir, identity)` names a berth under a runtime directory that is not the process's own.

  No cookie yet: this porter binds loopback. The door — login page, cookie, LOG OUT — is the next slice.

- 4ee180c: A session outlives its door: the porter's lifecycle.

  porter: a restarted porter adopts the sessions its predecessor started, from their berths under the state directory, rather than starting rivals. Idle sessions — no wire open, nothing through the door for `PORTER_IDLE_HOURS` (a day, like the cookie) — are ended by a sweep every minute: the process only; the state directory stays and the next login boots warm. `porter --status` lists the state directory's sessions and whether each answers. `deploy/` carries a systemd unit (a `porter` user, `KillMode=process` so a stopped door keeps its sessions), an env file example, and a Caddyfile for TLS in front. Boot lines kept per session are capped at 2000.

  calypso: a berth records the daemon's pid, so a host that did not start a daemon can still end it.

  chell: a daemon off a TTY tolerates EPIPE on its stdout and stderr — the porter that started it may stop first, and a session outlives its door.

- 21f8d21: The door itself: the porter logs a browser in and argus leaves by the door it came in.

  porter: `GET /login` asks for a username and a password; `POST /login` (form or JSON) trades the password for a CUBE token, starts or joins the session, sets a signed HttpOnly SameSite=Lax cookie naming it (Secure behind TLS, a day long by default) and sends the browser to `/s/<key>/?door`. The cookie gates the boot stream, the mount and the wire: a browser reaches only the session its cookie names; without it, the door (302), a refusal (401) or a dropped upgrade. `POST /logout` clears the cookie and leaves the session running. `PORTER_SECRET` signs the cookie; given none, one is made up per start and said so.

  argus: a LOG OUT pill beside AUDIO and the theme, in the frame's hue, standing only on a page that came through a door; pressed, it tells the door to forget this browser and goes to the door's login. The session is not touched. Law: a-surface-leaves-by-the-door-it-came-in.

- 1c169d7: The greeter: the door answers at once, and a boot is watched rather than waited for.

  porter: `POST /login` no longer holds the browser for a cold boot. A session already up is entered directly; one that must boot sends the browser to `/greet/<key>`, where the mise brain wakes — the same frames a terminal boot draws, paced by the page — and the daemon's boot rows arrive beneath it as they are written, ANSI and all, from the boot stream. `ready` rests the brain and hands the browser to the session; `failed` says why and offers the door again. The login page wears the same shell with the brain at rest. The porter serves the two modules it draws with from the installed wire package (`/greeter/brain.js`, `/greeter/ansi.js`); a booting identity is pending in the registry and reaches its mount only when its berth answers.

  menu: `@fnndsc/menu/ansi` — the ANSI-to-HTML converter and the console palette, moved from the ARGUS console so a browser greeter renders a boot the way the console renders a transcript; argus keeps the DOM half and re-exports the rest.

### Patch Changes

- Updated dependencies [d1a1c0d]
- Updated dependencies [3a8cd1b]
- Updated dependencies [1bdf876]
- Updated dependencies [4ee180c]
- Updated dependencies [c1178a0]
- Updated dependencies [5b520c7]
- Updated dependencies [810f3ba]
- Updated dependencies [7bba167]
  - @fnndsc/calypso@0.16.0
  - @fnndsc/chell@5.9.0
