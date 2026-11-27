# Exemplars — live-CUBE reference programs

Working, style-guide-conformant programs that exercise a **live CUBE** end
to end. They are simultaneously:

- **integration tests** — the unit suites mock every CUBE boundary; these
  validate the real contract (chrisapi behavior, PACS timing, job states);
- **reference code** — each is a worked example of how to program the
  sandwich, at two altitudes: the TypeScript API (`ts/`) and the chell CLI
  (`chell/`).

They are **not** part of `npm test` and never run in per-PR CI.

## The invariant

Every exemplar restores the CUBE to its pre-run state: feeds and scratch
files are deleted, PACSQueries removed, and DICOM series folders are deleted
only when the exemplar proved they were absent before its own retrieve.
Pre-existing PACS materialization is verified and left untouched; scheduled
automation never deletes and restores it. Fresh PACS folders are owned by the
CUBE admin, so cleanup of test-created retrievals needs admin credentials.
Testing delete-and-restore recovery requires an explicit manual run against a
disposable fixture; it is intentionally absent from scheduled automation.

## Configuration

Instance-specific test data — URLs, logins, and above all the designated
test accession — is **never committed**: accession numbers and DICOM UIDs
are identifiers. It lives in `exemplars/e2e.config.json` (gitignored; copy
`e2e.config.example.json` and fill it in). Real environment variables
override the file, which is how CI injects its secrets.

| key | required | meaning |
|---|---|---|
| `CUBE_URL` | yes | API base, e.g. `http://cube:8000/api/v1/` |
| `CUBE_USER` / `CUBE_PASSWORD` | yes | regular test user |
| `CUBE_ADMIN_USER` / `CUBE_ADMIN_PASSWORD` | for 03/04 | admin, PACS-folder cleanup only |
| `CUBE_PACS` | no (default `PACSDCM`) | PACS server identifier |
| `CUBE_TEST_ACCESSION` | yes | designated test study on YOUR instance |
| `CUBE_TEST_SERIESDESC` | scripts | a small series' description in that study |
| `CUBE_DCM2NIIX_VERSION` | no | pin when the newest build is broken |

Missing required values → the program prints a note and exits **2**
(skipped, not failed). Config is isolated to a temp directory per run —
your real chell session is never touched.

## TypeScript exemplars

```
npm run exemplars:build          # once, from packages/chell
node exemplars/ts/dist/01_connect.js
node exemplars/ts/dist/02_fsRoundtrip.js
node exemplars/ts/dist/03_feedDcm2niix.js   # pull → dircopy → dcm2niix → verify .nii → cleanup
node exemplars/ts/dist/04_pacsQR.js         # query → verify existing OR pull fresh → cleanup owned artifacts
node exemplars/ts/dist/05_calypsoDaemon.js  # live daemon WS surface → restart/context rehydrate
node exemplars/ts/dist/14_tokenLogin.js     # daemon started with a CUBE token on stdin, off a TTY → berth answers; a bad token is refused
node exemplars/ts/dist/15_accountSwitch.js  # connect as one user, then as another in the same process → who, what is read and what is held are the second's; needs CUBE_ADMIN_USER
```

Each prints ✓/✗ per check and exits 0 only if all passed.

## chell exemplars

chell expands `$VAR` / `${VAR}` environment references in command
arguments, so the scripts carry no instance data. Export your config,
connect once, then run against the established session:

```
. exemplars/e2e-env.sh          # exports exemplars/e2e.config.json
chell "$CUBE_USER@$CUBE_URL" -p "$CUBE_PASSWORD" -c version
chell -f exemplars/chell/10_fs_roundtrip.chell
chell -f exemplars/chell/20_pacs_qr.chell
chell -f exemplars/chell/30_feed_tour.chell
```

A script is played as a manifest: it stops at its first refused line and
exits non-zero, so script completion itself is the assertion (`-e` is
accepted and changes nothing). Caveats:

- **20** leaves pulled PACS files behind — chell has no admin credentials.
  Follow with the cleanup phase of TS exemplar 04, or delete the series
  folder as the CUBE admin.
- Script 30 is a read-only tour. A workflow that carries ids between
  commands names them with `A=$(…)`: see the manifests below.

## Bugs found by these exemplars (all fixed)

The first live runs surfaced five real defects, since fixed in the same
change set — the argument for keeping live exemplars around:

1. chell `pull` could not re-pull a series (synthetic query title
   collision) — titles now carry a timestamp.
2. A failed `query` exited silently in `-c` mode — it now prints the
   error stack.
3. A fresh connect combined with `-c`/`-f` in one invocation left cumin's
   IO layer uninitialized — cumin's connection singleton is now
   initialized in place instead of reassigned.
4. `-e` did not abort `-f` scripts on failed commands — builtins report
   through `process.exitCode`, which the script loop now honours.
5. cumin's reassigned `export let chrisConnection` broke ESM consumers
   (stale named-import bindings) — same in-place fix as 3.

Note: pl-dcm2niix needs its canonical arguments (see `DCM2NIIX_PARAMS` in
exemplar 03); bare defaults fail on typical series. The newest registered
build is not always the working one — on ekanite v2.0.0 fails where
v1.0.2 succeeds — so pin with `CUBE_DCM2NIIX_VERSION` (in CI: the
`CUBE_DCM2NIIX_VERSION` repo variable).

Stage-2 daemon exit-gate note: exemplar 05 is the topology proof. It starts
the daemon, attaches over WebSocket, drives live commands through the
daemon-hosted engine, and restarts the daemon to prove context rehydrate.
Browser compatibility is a separate ordinary-CI smoke in
`packages/calypso/tests/browser.test.ts`: an actual headless browser attaches
to a local daemon backed by a stub engine, so that proof needs no CUBE
credentials and cannot destabilize live-CUBE automation.

## Manifest exemplars

`flows/*.mise` are **manifests**: plain files of the lines an operator could
have typed, played by the kernel's own `play` (see `docs/manifest.adoc`).
They are the same artifact three ways — a test, a shareable workflow, and,
played at a surface with `--pace`, a demonstration.

They lift the caveat above. A run WAITS for its outcome, `A=$(…)` names
what it produced (`${A.instanceId}`, `${A.outputPath}`, `${A.feedId}`), and
`expect` refuses when a claim does not hold — so a workflow that captures
ids between commands needs no TypeScript program around it.

```
. exemplars/e2e-env.sh
chell "$CUBE_USER@$CUBE_URL" -p "$CUBE_PASSWORD" -c version
chell -c "play exemplars/flows/battery.mise --param SERIES=$CUBE_TEST_SERIESPATH"
```

| file | what it does |
|---|---|
| `00_session.mise` | Read-only claims about a connected session. Touches nothing. |
| `10_anonymize_nii.mise` | Roots a feed on a DICOM series, anonymizes it (`pl-pfdicom_tagSub`), proves the anonymization by reading tags back off the files it produced, converts the anonymized output to NIfTI (`pl-dcm2niix`), and removes the feed. |
| `battery.mise` | Plays them all. Its exit status is the gate. |

A manifest is read from the ChRIS filesystem, and from the engine's own disk
when CFS has no such file — which is how a repository's battery runs without
uploading itself first.

`CUBE_TEST_SERIESPATH` is a folder of DICOM the test user can read: a pulled
PACS series (`/SERVICES/PACS/<server>/<patient>/<study>/<series>`) or an
uploaded folder. Like every other identifier here it stays out of the repo.

The invariant holds: `10_anonymize_nii.mise` removes the feed it made — and
steps out of it first, because a workflow that deletes the place it is
standing in leaves the session in a hole. Nothing else is created.
