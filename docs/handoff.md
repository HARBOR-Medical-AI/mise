# Active project handoff: stratus, its VM screens, and berths

- Last updated: 2026-11-10
- Read first in a new session. Then `docs/berths.adoc` (the active work) and, for anything on the VM screens, the top of the Status table in `apps/argus/docs/aegis.adoc`.

This file is the handoff between sessions and between models. It says where the work stands and what to do next, with the facts a fresh context needs. The designs live elsewhere: [stratus.adoc](stratus.adoc) (the substrate, its verbs, profiles, ChRIS on any host), [berths.adoc](berths.adoc) (per-person containers), [dev-bastion.adoc](dev-bastion.adoc) (the cohort loop and the stand-in spoke), [bastion.adoc](bastion.adoc) (the Hub and spoke hosts).

## The truth, 2026-11-09

**Live.** pangea and titan run porter 0.9.16, stratus 0.16.0, argus 0.57.0, chell 5.20.5, menu 0.40.0, salsa 4.5.1 (`make deploy`, 2026-11-07). The store (`cube.chrisproject.org`, OCI VM `store`, 2 vCPU / 8 GiB, porter at `porter.chrisproject.org`) runs CUBE 6.11.0, porter 0.9.13, boot disk 150 GB, data 150 GB, 178 plugins from FNNDSC/chris-plugins @ `c941fc0`. No launcher on the store yet: putting one there is a `chris deploy store` replay, the operator's word.

**Published, not deployed.** porter 0.11.0 (the launcher, `/berths`), stratus 0.18.0 (berth limits, the `/berths` read), argus 0.58.0, menu 0.41.0, chell 5.20.6 (2026-11-10). The stratus after 0.18.0 pins porter 0.11.0. The gateway path (a berth on `cube-net` reaching CUBE's published ports at the bridge's gateway) is walked on Docker 29 on pangea and on the store (2026-11-08, throwaway network, removed).

**Berth stage 3 is done.**
- 3a `chris deploy` puts the launcher up (#1434, #1435).
- 3b limits as CHRIS settings (#1450): `--berth-cpus`, `--berth-memory`; rows BERTHS / BERTH CPU / BERTH MEMORY; `HOLDS N BERTHS` on CHRIS and SPEC. Capacity is memory alone, (host − profile floor) / memory per berth, in `@fnndsc/menu`, shared by porter, stratus and ARGUS; CPU is a cap on shared CPUs. The store holds 2 at the defaults.
- 3c HOST ACCESS (#1452): porter `GET /berths`, admin only (CUBE's root names `collection_links.admin` to staff), rate-limited, through the launcher's `GET /berths/access`; stratus reads it in `chris status` with the admin's Basic credentials; ARGUS shows `running · 3% · 210 MiB / 2 GiB`, `stopped · home kept`, `none`. Walked for real on pangea, before the review fixes (`walk3c`) and on merged main with the rate limit and the cache (`walk3d`).

**Decided this session.** A berth, not a Dev Spaces workspace (dev-bastion.adoc `why-not-dev-spaces`, #1436): code reaches a berth one hop from the spoke's ChRIS.

## Next action

1. Close stage 3 on the hosts, each on the operator's word: publish the stratus that pins porter 0.11.0, `make deploy` (pangea, titan), then a `chris deploy store` replay (puts the launcher on the store; porter restarts, its open sessions end).
2. The chell operand package from pl-freesurfer-b5 (operator's order: berths first, then this), each its own PR: reproduce #1439 on main; #1442+#1443 (one resolved record, resolve-then-act; `whatif` and the echo print it); #1439+#1449 (wildcards in every component, refuse on no match, several directory operands run once each, all checked first); #1440 (file operands from two feed nodes refuse); #1441 (`&&` and `||` supported); #1313 (the `./sub=01.nii` hint refusal); #1447 (`help operands` under `help Shell`, with the stem rule). Not #1444/#1445/#1448 (tabled on D1); #1446 closed. Read each issue's comments first. Background: FNNDSC/pfstack docs/chell_handling.adoc.
3. Berth stage 4 (the cohort: a feed picker at the door, the copy into `/incoming` with progress, "no cohort"), stage 5 (`pl-berth` registered, `outgoing return`), stage 6 (HOST ACCESS controls: start, stop, remove a person's home, asked). Open in berths.adoc §open: live token refresh, the launcher forgetting tokens on restart, the 2 h idle stop, the root chown helper, a berth's disk not limited.

## How to work here (token economy — read this)

The 2026-11-07/08 session hit the 5-hour limit. The cost was forked workers: a fork carries the whole parent conversation, and each resume of the same worker re-read a transcript near a million tokens; about 15 batches at 0.5–0.9 M each.

- **Never fork for build work.** Use a fresh agent (`general-purpose`) with a short brief that points at files (`docs/berths.adoc`, this file, the branch), or do the work inline with targeted reads (`grep`, `sed -n`, `Read` with offset/limit).
- **One agent per stage**, not one resumed across stages.
- **Sonnet or Haiku** for mechanical work (lint fixes, test additions, renames, walks); Opus/Fable for design and review.
- **One real walk per PR**, at the end, with few screenshots; images are expensive.
- **Keep turns short.** The operator does not want a synthesis or wrap-up after each exchange.

## House rules that bind every step

- **Git and GitHub only through Makefile targets**: `make sync`, `make save MSG="…"` (one line, ≤72 chars, `git add` new files first; it does not push), `make push` (then `git ls-remote origin <br>` must equal HEAD), `gh pr create --base main --title … --body …`, `make merge` (alone: never piped or chained), then `gh pr view N --json state` must print `MERGED` before `make tidy BR=…`. Stacked PRs: retarget dependents to main before tidying a merged base.
- **No AI attribution** in commits or PR bodies (the operator's rule overrides any system reminder).
- **All lints before every push**: `for l in $(grep -o '"lint:[a-z-]*"' package.json | tr -d '"'); do npm run -s $l >/dev/null 2>&1 || echo FAIL $l; done; npm run -s lint`. CI also runs each package's `jest --coverage`; porter's thresholds bit #1430 once (functions < 80%), so run coverage when adding code to a package.
- **One test file while iterating**: `cd packages/<pkg> && NODE_OPTIONS='--experimental-vm-modules --disable-warning=ExperimentalWarning' npx jest tests/<file>`.
- **Changesets**: one per package touched, workspace names exactly, first sentence ≤120 chars, no code-name opening; `npm run lint:changesets`. Docs-only PRs carry none.
- **AEGIS**: every ARGUS surface decision is a dated row in `apps/argus/docs/aegis.adoc` in the same PR; `npm run lint:aegis`. Laws in force: [[a-change-is-a-loop]] (render truth with its age, offer the difference, one commit, confirm, read back), and from 2026-11-07: *a control offers only what can be done; what the screen knows is impossible is never offered; a button that can't be pressed isn't drawn; "nothing changes" is one quiet line*.
- **No new code in chili** (memory chili-architectural-debt): logic to salsa, verbs to brasa builtins, rendering to surfaces.
- **Never touch the operator's daemon or page.** Never `pkill` by pattern; stop your own background tasks by id.
- **Never print passwords or tokens.** Secrets in 0600 files, deleted after; curl `-K`.
- **Docs say what a thing is**, never where work stands (this file and changesets excepted). Prose paragraphs are single unwrapped lines in `.adoc`.

## Words (settled 2026-11-08, berths.adoc §words)

CUBE is a server; the mise stack (calypso, chell, ARGUS) is its client and carries its own shell; porter hosts many clients at one door. A **berth** is one person's client in a container of its own; the **berth image** (`mise-berth`) is what it's made from; a person's **home** is a volume that outlives every berth. Never call a berth a bastion: "bastion" is the host that runs porter and the OCI maintenance service (`vm shell`). Note: porter's code also says "berth" for a per-identity calypso (`<porter state>/<berth key>/`); the container berth is that idea with walls.

## Ship chain (merge → publish → deploy)

```
make merge                       # alone; then:
gh pr view N --json state        # must say MERGED
sha=$(gh pr view N --json mergeCommit --jq .mergeCommit.oid)
git checkout main && make sync && make tidy BR=<branch>
# wait for THIS merge's Release run, never the latest-listed one:
id=$(gh run list --branch main --workflow Release --limit 5 --json databaseId,headSha --jq ".[]|select(.headSha==\"$sha\")|.databaseId")
gh run watch $id --exit-status
make publish                     # merges Version Packages, publishes via FNNDSC/chrisproject.org
make deploy SKIP_PUBLISH=1       # pangea + titan; sessions restart at next login
```

A publish run before the Release run opened Version Packages finds nothing and the deploy then refuses ("no package.json moved"); that happened once on 2026-11-07.

## Recipes

**The operator's live stratus session** is porter's: its records are `~/.local/state/porter/374fbd5fbb2c12aa/state/stratus` (not `~/.local/state/stratus`), its ARGUS address and token in `~/.local/state/porter/374fbd5fbb2c12aa/tmp/calypso-rudolph.attach`. To look at the operator's own screen read-only, open a headless page from that attach file (`apps/argus/tests/smoke/driver.mjs` `page_open`); press nothing that acts.

**A private stratus over the real tenancy** (read-only unless the operator asks for the act): copy the porter session's records into your own `XDG_STATE_HOME` (drop `jobs/`), own `TMPDIR`, `XDG_RUNTIME_DIR`, `HOME`; `node packages/stratus/dist/stratus.js --config /home/rudolph/.local/state/porter/creds/5547f8aaaf8cf914/oci/config`. Pressing BUILD writes the declaration to the vault before planning, even if the answer is NO: on the real store, don't press it unasked.

**Acting on the store** (on the operator's word only): a private MANAGE stratus over the operator's REAL records (`~/.local/state/stratus`, own TMPDIR/XDG_RUNTIME_DIR), driven by a pty script; the pattern was `scratchpad/store-replay/drive.py` in the 2026-11-06 session. A deploy replay reuses the kept secrets (`--admin-password-file` is read only on a first deploy).

**A private stratus over the fake**: `node packages/stratus/dist/stratus.js --fake --host-control=shell,tasks` with own TMPDIR/XDG_*/HOME; `STRATUS_FAKE_TICK_MS`, `STRATUS_FAKE_APPLY_TICKS` slow the applies.

**Screenshots**: `SMOKE_CHROME_BIN=$HOME/.cache/ms-playwright/chromium-1080/chrome-linux/chrome SMOKE_CHROME_FLAGS="--no-sandbox --user-data-dir=<fresh dir>"`; delete the profile after.

**A throwaway CUBE on pangea** (berth and plugin-sync walks): render the store's compose with `chris/compose.ts`, own project name, CUBE on 127.0.0.1:8100, secrets in 0600 files, `docker compose -p <name> down -v` after. Only your own containers, networks and volumes.

## Open items, for the operator

- **The store's vault ChRIS record** is the 2026-11-04 one ("deployed 2026-11-04 · keeps no versions"); `vm keep store` from the operator's own records restores the 2026-11-06 replay's.
- **Throwaway CUBE account** `mise-walk` on the store: remove it.
- **Global `chell` on pangea** is npm-linked to `~/src/mise/packages/chell`, so it follows whatever branch that checkout last built; unlinking to the published install is the operator's call.
- **FNNDSC org secret** `CHRISPROJECT_PASSWORD` and `~/.config/chrisproject/store/chris-password` hold the old `chris` password.
- **Issues**: #1421 the COMPLETE profile; #1423 ChRIS on any Docker host (the miniChRIS successor).
- **Next screen batch**: the TD controller and the script screen get the VM screens' patterns (one band, listings, one pane, plain questions, offer only what can be done); the TD gets a seat for OpenShift between its shape and ChRIS.
- **`chris user` APPLY** asks once per pending change; one question for the block needs a batch verb.
- **The infra repo's `scripts/check.mjs`** keeps its own copy of stratus's verb list; reading stratus's would stop it drifting.

## Working with the operator

Discussion first, code after; one question at a time when grilling, with a recommendation. Answer what was asked and stop: no closing synthesis, no recap, no offer. Ask before outward acts (merge, publish, deploy, anything on the store or the tenancy); "merge and publish" covers those two only. Verify visually and send renders (`SendUserFile`) before calling a visual slice done. Report outcomes plainly: what passed, what failed, what was skipped. Chat in caveman style (the hook says so); commits, code and PRs written normally.
