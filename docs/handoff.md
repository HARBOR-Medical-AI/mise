# Active project handoff: stratus (epic #1056)

- Last updated: 2026-10-31 (the foundations bullet below; the rest as of 2026-10-23)
- Foundations and the ChRIS layer (2026-10-31): grilled with the operator and written as [stratus.adoc D16](stratus.adoc#foundations): OPENSHIFT, VM and CHRIS as layers, TRUSTED DOMAIN as the recipe, `domain` renamed `cluster`, the store's `.mise` script as the truth. The store was built by hand once and torn down ([howto-store-vm.adoc](howto-store-vm.adoc)); the empty compartment `chrisproject-services` is kept. The FNNDSC org secrets `CHRISPROJECT_USERNAME` (`chris`) and `CHRISPROJECT_PASSWORD` were reset 2026-10-31; the password is `~/.config/chrisproject/store/chris-password` on pangea. Next: slice 1, the rename. Branch names never start `agent/`.
- Last verified against `main`: the Version Packages merge #1213, 2026-10-22
- Working branches: `agent/size-zone` (#1234: the DNS zone, OCI's not-found waits, claims at paint, STOPPED), and `agent/chris-steps` stacked on it (the ChRIS steps); retarget the second to `main` before tidying the first
- Epic status: comment posted on #1056, 2026-10-22 (follow-up 4 closed)
- Current milestone: steps 1 to 4 of the order of work in [stratus.adoc](stratus.adoc#order) are on `main` (step 4 as #1200 to #1205) and published (@fnndsc/stratus 0.2.1, deployed on pangea 2026-10-22; titan carries no stratus). The live domain `harbor` is adopted into the operator's own state (`~/.local/state/stratus/domains/harbor`, reusing the stack tagged `mise-domain=harbor`), and `domain verify harbor` passes 10 of 10 there, the block-volume probe included (its 50 GiB claim made, read back and released, the compartment back to six volumes)
- Next action: quay is built live (2026-10-23, from the controller: billing accepted 18:18 EDT, installed 19:09, verify 10 of 10, $0.70 an hour; protected) and stays up. The ChRIS steps (`postinstall`, `verify`, `chris-deploy`, `chris-seed`, `smoke`, [stratus.adoc D14](stratus.adoc#d14)) are built on `agent/chris-steps` and pass over fakes; next they run live on quay (`domain build quay`), then #1234 and the ChRIS branch merge on the operator's word. Owed after: a play that follows a build holds the session's one lane, so ARGUS's tiles and every other line wait behind it; a line whose surface left cannot be stopped from another; a claimed line typed in one browser can open in another. The OCI bootstrap is still owed (D14, Bootstrap)

This file is the handoff between sessions and between models. It says where the work stands and what to do next, with the facts a fresh context needs to do it without rediscovery. The design itself is [stratus.adoc](stratus.adoc); the bastions are [bastion.adoc](bastion.adoc) and [dev-bastion.adoc](dev-bastion.adoc); what Red Hat ships against the primitive is [redhat-fl.adoc](redhat-fl.adoc); the metaphor every figure is drawn in is [linux-metaphor.adoc](linux-metaphor.adoc).

## House rules that bind every step

These are enforced by the operator in review and most by lint. Read the pointed files before the first commit.

- **Git and GitHub only through Makefile targets**: `make sync`, `make branch BR=…`, `make save MSG="…"`, `make pr`, `make rebase`, `make merge`, `make tidy BR=…`, `make publish`, `make verify-npm`. `MSG` is one line, no `!`, subject ≤ 72 characters; put detail in the PR body with `gh pr edit N --body-file …`.
- **`make merge` runs alone**, never piped, never chained with `;` or `&&`. Then `gh pr view N --json state` must print `MERGED` before `make tidy` is typed. A pipe into `tail` hides make's exit code; twice a red merge followed by tidy deleted a live branch and closed its PR. A PR whose checks went red before a fix landed on `main` needs `make rebase` first; `make merge` rebases only when GitHub says BEHIND or DIRTY.
- **No AI attribution** in commits or PR bodies. No process jargon (phase, wave, remediation) in source or config comments.
- **All CI lints before every push**: `for t in lint:tests lint:seam lint:casts lint:kernel lint:fond lint:trek lint:core-deps lint:stratus-deps lint:commands lint:prompt lint:wire lint:listings lint:changesets lint:aegis lint:orrery lint; do npm run -s $t || echo FAIL $t; done`, plus `node packages/stratus/scripts/stratusBoot.mjs` and `node packages/brasa/scripts/coreBoot.mjs`.
- **One test file at a time while iterating**: `cd packages/<pkg> && NODE_OPTIONS='--experimental-vm-modules --disable-warning=ExperimentalWarning' timeout 110 npx jest tests/<file>`. Never `npm test -- file`, never bare `npx jest`. Strip ANSI and grep `●|Tests:|FAIL|does not meet` when reading output.
- **Changesets**: one per package touched, package names exactly as the workspace spells them (`@fnndsc/argus`, not `argus`), first sentence ≤ 120 characters (it is the operator's WHAT'S NEW row); `npm run lint:changesets`. Docs-only PRs carry none.
- **AEGIS**: every ARGUS surface decision lands as a dated row at the top of the Status table in `apps/argus/docs/aegis.adoc` in the same PR; `npm run lint:aegis`. `components.adoc` beside it is the reference for a new component.
- **Never touch the operator's daemon.** Live checks run on a private daemon (recipe below). Never `pkill` by pattern; kill one pid.
- **Docs say what a thing is**, never where work stands; this file and changesets are the exceptions. No hard-wrapped paragraphs in `.adoc`.
- **TypeScript style**: `packages/*/TYPESCRIPT-STYLE-GUIDE.md`; RPN names (`thing_verb`), explicit types, JSDoc on every export.
- **Design from the tree**: a new path, kind or verb is argued from what ChRIS already mounts (`/net/pacs`, `/proc/jobs`), never from the document under review.
- **Analogy guard**: before writing "X is really a Y", ask what runs it and where. A matched name is not an argument. The dev bastion is a shell over a cohort, not a plugin; never reintroduce the plugin frame or `chris_plugin` scaffolding into the bastion material.

## Decisions settled this week (do not reopen)

- **Three bastions, one shape, disjoint key rings.** The Hub cloud controller holds cloud keys and builds TDs, outside every tenancy it builds (no instance principal). The Hub dev bastion holds a porter door token per spoke bastion and no cloud key. A spoke bastion holds that TD's CUBE token only: no `oc`, no kubeconfig, no registry. The host shell is reached one way: chell, through porter, to calypso, and `!` under the `shell` tier. No ssh, no `oc rsh`, no other door is part of the design.
- **The dev bastion is a shell over a cohort.** A project directory with `/incoming` and `/outgoing` mounted under a policy set when the host is made (open: data readable in the shell; sealed: `/incoming` is a listing, only gated code runs against the files as a job, `/outgoing` shown per policy). Common case: code is written at the Hub and shipped as source to each spoke bastion; the exception is a developer inside under the open policy. Packaging as a plugin is an optional later exit, never the model.
- **The berth** is one string everywhere, `user@tenancy` exactly as the cloud writes it (two `@` when the user is an e-mail). The prompt shows it in full and truncates from the left when tight. `whoami` and the prompt agree.
- **Figure colours**: blue mise, green Linux, white ChRIS, red Red Hat only, orange Oracle Cloud Infrastructure, pale tints for machine boxes, amber for key files. Wordmarks as text, no logo art.
- **Red Hat gap, verified 2026-10-21**: no Red Hat product does "edit at one OpenShift, run in N others" (redhat-fl.adoc). The pitch sentence: you ship the fleet and the workspace; HARBOR is the loop between them, under policy, with provenance.

## Where the code stands

| Piece | State | Where |
|---|---|---|
| `@fnndsc/stratus` 0.5.1 | published through OIDC with provenance; trusted publisher configured; on pangea at `~/.local/share/porter-published/node_modules/.bin/stratus`, and started by porter on `stratus oci`, which asks READ or MANAGE at the door (D14) | `packages/stratus`; npm page `@fnndsc/stratus` |
| Step 5, the second tenant: quay built live 2026-10-23 and torn down 2026-10-25; D15 found domains (#1290); the capacity pane (#1291, #1293) | on `main` | `packages/stratus/src/domain/`, `apps/argus/src/features/controller/` |
| Found domains seen from the cloud, adopted domains torn down, teardown of what carried the tag (2026-10-29) | branch `stratus/trusted-domains-seen`: a found domain's address, spec, condition (UP, STOPPED, GONE) and attested steps without adoption; `domain teardown` on a GONE found domain without adoption and on an adopted one once unlocked; teardown removes the stack itself, tagged volumes left in the compartment, and `domains/<name>` with its bucket (another's compartment loses the tag); TRUSTED DOMAINS on every ARGUS surface | `packages/stratus/src/domain/found.ts`, `commands/{domain,teardown,build}.ts`, `cloud/oci/{builder,buildApi,rmApi}.ts`, `apps/argus/src/features/controller/screen.ts`, `compositions/stratus/tiles.ts` |
| Step 1a: read the tenancy | on `main` (#1181): descriptor, `CloudDriver`, fake driver and contract suite, OCI identity and compartments, `/net/oci/<tenancy>/` and `regions/`, launcher, stratus boot, `lint:stratus-deps` | `packages/stratus/src/{backend,session,cache,names,args,stratus}.ts`, `cloud/{driver.ts,fake/,oci/}`, `vfs/{tenancy,look}.ts`, `tests/` |
| Step 1b: prompt segments and the ARGUS composition | on `main` (#1187) | `packages/menu/src/messages.ts` (`promptSegmentSchema`, `segments`), `packages/menu/src/logo/tdMark.ts`, `packages/stratus/src/prompt.ts`, `packages/chell/src/core/prompt/`, `apps/argus/src/console/promptBar.ts`, `apps/argus/src/app/main.ts`, `assets/brand/td-oci.svg`, `scripts/prompt-parity.mjs` |
| Follow-ups 1 to 3 | on `main`: `chell --remote <berth>` by the exact identity, two-@ too (#1190, `packages/chell/src/remote/berthTarget.ts`); a frame-alone session boots unzoomed (#1191); the attach splash follows the backend, the TD mark for stratus (#1192, `packages/chell/src/remote/splash.ts`) | |
| Defects found on the way | on `main`: a non-ChRIS attach greets without the `motd` refusal or ChRIS packages; a remote line's live output goes to the sink it was sent from (#1194); `ls -l` pads owners to the widest; text filters say the session's files (#1195) | `packages/chell/src/core/greeting.ts`, `packages/chell/src/remote/remoteEngine.ts`, `packages/brasa/src/core/version.ts` (`versions_selectForBackend`), `packages/fond/src/vfs/render.ts` |
| Step 2: resources in the tree | on `main` (#1193): one driver method per kind plus `objects_list links_list object_read records_list resources_search`; every container level holds `instances networks loadbalancers volumes buckets dns` for the session's region; verified live and read-only against `fnndsc-bch` on 2026-10-21 | `packages/stratus/src/cloud/{driver.ts,fake/driver.ts,oci/resourceApi.ts,oci/resourceMap.ts,oci/driver.ts}`, `vfs/{resources,tenancy,look}.ts`, `backend.ts` |
| Step 3: domains, read | on `main` (#1196, #1197): `stratus --domain <name>=<harbor-oci checkout>`; `domains/<name>/` with `spec.yaml settings state.json steps/ auth/`, steps read from the evidence harbor-oci keeps; `domain status` and `capacity` with the `stratus.domains` and `stratus.capacity` models; the DOMAINS and CAPACITY tiles. `domain verify` and `spend` came with step 4 | `packages/stratus/src/{domains/harborOci.ts,vfs/domains.ts,commands/domain.ts,commands/capacity.ts,args.ts}`, `packages/menu/src/substrate.ts`, `apps/argus/src/compositions/stratus/tiles.ts` |
| Step 4: build, adopt, verify, spend, teardown | on `main` (#1200 to #1205): brasa's runner (`core/runner.ts`), `kill`, `wait`, calypso's `tasks` tier; `domain new`, `plan`, `build` over the fakes and over OCI (Resource Manager, the Assisted Installer); `domain adopt` (harbor's stack, tagged `mise-domain=harbor`, holds its imported state; re-plan: 21 replaces and 24 tag drift, apply refused); `domain verify` (9 of 10 live, the probe unrun); `spend` and DOMAINS' hourly cost ($0.71/h live); `domain teardown` (CSI volumes read from the cluster's PersistentVolumes). The live build has not run | `packages/brasa/src/{core/runner.ts,builtins/sys/tasks.ts}`, `packages/stratus/src/{domain/,installer/,cluster/,cloud/builder.ts,cloud/fake/builder.ts,cloud/oci/{rmApi,buildApi,builder,planRead,stackVars}.ts,commands/{build,verify,spend,teardown}.ts}` |
| Bastion documents and figures | on `main` (#1185, corrected by #1186) | `docs/bastion.adoc`, `docs/dev-bastion.adoc`, `docs/redhat-fl.adoc`, `docs/linux-metaphor.adoc`, `docs/images/*.png` |
| Figure sources | a private Design canvas owned by the operator; the repo holds the 2x PNG exports | ask the operator for the canvas; re-export is a headless-chromium screenshot of the board's HTML |

What the wire carries now: `promptline.context.segments?: Array<{key, label, value, tone}>`, tones `leader | place | identity | path | work | note | alert`. Keys stratus uses: `cloud tenancy region user domain cwd`. A surface maps tone to palette; glyphs by key in chell's `theme_p10k.ts` and ARGUS's `terminal.ts` (`lint:prompt` holds them equal).

## Recipes

**Porter's stratus session keeps its own state folder** (`<porter state>/<berth key>/state/stratus/domains/`, with `HOME` beside it), not the operator's `~/.local/state/stratus/domains/`. Every domain is seen there from the cloud; acting on one needs `domain adopt <name>` in that session, and its `auth/` (the kubeconfig, the CUBE token) copied in by hand. `stratus oci` at the ARGUS console (or the ChRIS dashboard's CLOUD tile) asks READ or MANAGE at the door; `stratus oci manage` answers in words; a session already up on the other answer is restarted on the new one.

**A private stratus daemon over the fake cloud** (never the operator's daemon):

```
S=<scratch>/stratus-fake; mkdir -p $S/{tmp,run,config,cache,home}
env TMPDIR=$S/tmp XDG_RUNTIME_DIR=$S/run XDG_CONFIG_HOME=$S/config XDG_CACHE_HOME=$S/cache HOME=$S/home \
  node packages/stratus/dist/stratus.js --fake </dev/null >$S/daemon.log 2>&1 & echo $! > $S/pid
grep -o 'http://127.0.0.1:[0-9]*/?token=[0-9a-f]*' $S/daemon.log
```

`HOME` must exist: the terminal console's pty chell starts there and dies with `chdir(2) failed` otherwise. Stop it with `kill $(cat $S/pid)`. Against the live tenancy, drop `--fake` and give the daemon a real `HOME` whose `~/.oci/config` holds the profile; every change that touches the tree is checked live and read-only (stratus.adoc, test strategy).

**A chell attached under a pty** (the prompt is interactive): `pty.fork()` with the same four variables and `HOME`, `node packages/chell/dist/index.js --remote <the URL above>`, read until the prompt, write lines, strip ANSI. Attaching by the printed URL or by the berth (`chell --remote rudolph@fnndsc`) both work.

**ARGUS screenshots** without Playwright: `apps/argus/tests/smoke/driver.mjs` exports `page_open(url)` returning `{ eval, shot, send, close }` over CDP. Run with `SMOKE_CHROME_BIN=$HOME/.cache/ms-playwright/chromium-1080/chrome-linux/chrome SMOKE_CHROME_FLAGS="--no-sandbox --user-data-dir=<fresh dir>" SMOKE_CDP_PORT=<free port>`. Chromium 153 on this host cannot load loopback pages headless; the 1080 build can.

**npm's advisory endpoint flakes** (503 or a five-minute timeout on `/-/npm/v1/security/advisories/bulk`, seen 2026-10-22): the required `audit` check then fails with "audit endpoint returned an error", which is not a finding. Rerun only that job (`gh run rerun <run> --failed`) until it answers, then `make merge` alone. With strict protection every merge makes the next PR BEHIND; `make rebase` first when its last checks were red, since `make merge` rebases only on BEHIND or DIRTY.

**Build order** when types cross packages: `npm run build -w @fnndsc/menu`, then stratus, chell, calypso, argus as needed (`npm run build` at the root builds all in order).

**Figure re-export**: strip the Design wrapper (`support.js` line, `<x-dc>`, `<helmet>`, the `text/x-dc` script), screenshot with the 1080 chromium at `--force-device-scale-factor=2 --window-size=1680,<h+80>`, crop to the board size, save under `docs/images/`.

## Running a session against the live tenancy

Porter serves ChRIS sessions only; a stratus session is its own daemon. On pangea, as the operator, with the real `HOME` (its `~/.oci/config`):

```
~/.local/share/porter-published/node_modules/.bin/stratus --domain harbor=$HOME/src/harbor-oci
```

It prints a `http://127.0.0.1:<port>/?token=…` URL for ARGUS (the DOMAINS and CAPACITY tiles and a terminal console) and a berth for `chell --remote <identity>`. Without `--host-control=tasks` nothing it does changes the cloud; with it, `domain build`, `teardown`, `adopt`'s state import and verify's probe may. A daemon started for one task with `tasks` is stopped by its PID when the task is done.

The tag sweep is not a pending task: it is the design item in stratus.adoc's order of work, designed when it is reached and first run in a scratch compartment.

## Steps 4 and on

Settled 2026-10-22 and written into stratus.adoc (D3, D4, D6, D7, D8, D10, D11, D13, order of work): harbor-oci is never run; three driver kinds (cloud, installer, cluster) with the steps written once in `domain/steps.ts`; Terraform through OCI Resource Manager; brasa core's runner with `kill` and `wait`; the `tasks` tier as a launch-time gate, and without it nothing changes outside the host; domain state under `$XDG_STATE_HOME/stratus/domains/<name>/` with the stack tagged for rediscovery; the live domain adopted for plans only; verify in two modes; teardown's first form, which removes the domain's tagged CSI volumes and is confirmed by typing the name. The order: 4a runner and tier on fakes, 4b adoption (plan only), 4c verify and spend, 4d a real build in a scratch compartment on the operator's word; then the cluster in the tree, then the controller against its mockup. Each is its own PR; do not start one unasked.

## Open questions, for the operator

- Who runs the sealed job in a spoke bastion: the same container with the mount hidden from the shell, or a job the session launches (dev-bastion.adoc, open).
- How source crosses the wire from the Hub dev bastion to a spoke bastion, and what the gate is.
- The Hub bastion as a pod on the Hub cluster: entrypoint, mounted Secrets, who may reach its porter.
- Whether the spoke bastion is OpenShift Dev Spaces or a plain Deployment.
- Whether the Version Packages flow should stage publishes rather than allow direct publish per package (npm warns; today all packages allow direct publish).

## Working with the operator

Discussion first, code after: "DO NOT DRAW" and "comment first" are literal. In discussion, answer what was asked and stop; no closing recommendations. When the operator corrects a frame, re-read every sentence that used the frame, not only the ones that named it. Verify visually and send the renders (`SendUserFile`) before saying a visual slice is done. Report outcomes plainly: what passed, what failed, what was skipped.
