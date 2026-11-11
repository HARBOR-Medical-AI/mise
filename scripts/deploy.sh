#!/usr/bin/env bash
# Deploy: publish what main holds and put it on the hosts, in the order that
# cannot leave a host empty.
#
#   make deploy                 publish via the Version Packages PR, then install
#   make deploy HOSTS=pangea    one host only (pangea | titan | "pangea titan")
#   make deploy SKIP_PUBLISH=1  published already: waits out main's release run, then installs
#
# Rules (2026-10-05, after a reinstall left both hosts empty for minutes):
#   1. every package is verified on npm — the exact version — before any
#      install is touched; the registry lags the release run by a minute or two;
#   2. install before remove: never `npm uninstall` first; npm replaces the tree;
#   3. titan's root npm keeps its own packument cache: --prefer-online.
# The packages are porter's dependency closure in this checkout, so the list is
# never typed by hand and a host gets everything main holds.
# Between the npm check and the installs, the "Berth image" workflow builds the
# berth image on main and is waited for, so mise-berth:latest holds the calypso
# and chell the hosts are about to run.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
HOSTS=${HOSTS:-"pangea titan"}
SKIP_PUBLISH=${SKIP_PUBLISH:-}
PANGEA_PREFIX=${PANGEA_PREFIX:-$HOME/.local/share/porter-published}
TITAN=${TITAN:-titan}
# Where the packages are published from (the Makefile's PUBLISHER_REPO).
PUBLISHER_REPO=${PUBLISHER_REPO:-FNNDSC/chrisproject.org}

say() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] FAIL: %s\n' "$*" >&2; exit 1; }

if [ -z "$SKIP_PUBLISH" ]; then
  pr=$(gh pr list --head changeset-release/main --state open --json number --jq '.[0].number')
  [ -n "$pr" ] || die "no open Version Packages PR: nothing to publish (merge the change first, or SKIP_PUBLISH=1 to install what npm has)"
  say "Version Packages PR #$pr: nudging its CI, then publishing"
  gh pr close "$pr" >/dev/null 2>&1 || true; sleep 5; gh pr reopen "$pr" >/dev/null 2>&1 || true; sleep 30
  # `make publish` merges, then runs the publisher (FNNDSC/chrisproject.org's
  # publish-mise.yml, see the Makefile) and waits for it: it fails if npm did.
  make --no-print-directory publish 2>&1 | grep -vE '^\s*$|Waiting|^All checks' | tail -3
  [ "${PIPESTATUS[0]}" -eq 0 ] || die "make publish did not succeed"
  say "publisher run: success"
else
  # Published elsewhere (make publish a moment ago), a publisher run may still
  # be pushing to npm: wait it out rather than give up on the registry first
  # (2026-10-07: the npm wait timed out under a release run still in flight).
  run=$(gh run list -R "$PUBLISHER_REPO" --workflow publish-mise.yml --limit 1 --json databaseId,status --jq '[.[] | select(.status != "completed")][0].databaseId // empty' 2>/dev/null || true)
  if [ -n "$run" ]; then
    say "publisher run $run: waiting for it to finish"
    gh run watch "$run" -R "$PUBLISHER_REPO" --exit-status >/dev/null 2>&1 || die "publisher run $run did not succeed"
    say "publisher run $run: success"
  fi
fi

git fetch -q origin && make --no-print-directory sync >/dev/null 2>&1 || true

# Every workspace package porter runs (its dependency closure in this checkout),
# as workspace dirs: a host gets what main holds, not only what the last release
# bumped (2026-11-10: two releases in a row left pangea's argus and menu one
# behind, because the second bumped stratus alone).
dirs=$(node -e '
const fs = require("fs"), path = require("path");
const ws = {};
for (const root of ["packages", "apps"]) for (const d of fs.readdirSync(root)) {
  const f = path.join(root, d, "package.json");
  if (fs.existsSync(f)) { const p = JSON.parse(fs.readFileSync(f, "utf8")); ws[p.name] = { dir: path.join(root, d), p }; }
}
const seen = new Set();
(function walk(n) {
  if (!ws[n] || seen.has(n)) return;
  seen.add(n);
  for (const k of Object.keys({ ...ws[n].p.dependencies, ...ws[n].p.optionalDependencies })) walk(k);
})("@fnndsc/porter");
seen.delete("@fnndsc/porter");
console.log([...seen].sort().map((n) => ws[n].dir).join("\n"));
')
[ -n "$dirs" ] || die "porter has no workspace dependencies in this checkout"

spec=""
for d in $dirs; do
  name=$(node -pe "require('./$d/package.json').name"); want=$(node -pe "require('./$d/package.json').version")
  got=""
  # Listed is not served: the registry names a version minutes before its
  # tarball answers (2026-10-06: porter 0.6.1 listed, tarball 404 for ~4 min,
  # and the pangea install failed). Wait for both.
  tarball=""
  for _ in $(seq 1 40); do
    got=$(npm view "$name@$want" version --prefer-online 2>/dev/null || true)
    tarball=$(npm view "$name@$want" dist.tarball --prefer-online 2>/dev/null || true)
    [ "$got" = "$want" ] && [ -n "$tarball" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "$tarball")" = 200 ] && break
    got=""; sleep 15
  done
  [ "$got" = "$want" ] || die "$name@$want is not served by npm yet; nothing installed"
  say "$name $want on npm"
  spec="$spec $name@$want"
done
pv=$(node -pe "require('./apps/porter/package.json').version")
say "porter $pv; installing:$spec"

# The berth image is made from the calypso and chell npm names as latest
# (images/mise-berth/pins.mjs). Built on main now that both are served, and
# waited for, so mise-berth:latest holds this release before any host runs it.
# The run is found by its id, above the newest one before the ask.
berth_last=$(gh run list --workflow "Berth image" --limit 1 --json databaseId --jq '.[0].databaseId // 0' 2>/dev/null || true)
gh workflow run "Berth image" --ref main >/dev/null 2>&1 || die "the Berth image workflow did not start (gh workflow run \"Berth image\" --ref main); nothing installed"
berth_run=""
for _ in $(seq 1 20); do
  berth_run=$(gh run list --workflow "Berth image" --branch main --event workflow_dispatch --limit 5 --json databaseId --jq "[.[] | select(.databaseId > ${berth_last:-0})][-1].databaseId // empty" 2>/dev/null || true)
  [ -n "$berth_run" ] && break
  sleep 3
done
[ -n "$berth_run" ] || die "the Berth image run did not appear a minute after it was asked for; nothing installed"
say "berth image run $berth_run: building mise-berth:latest on main, waiting for it to finish"
gh run watch "$berth_run" --exit-status >/dev/null 2>&1 || die "Berth image run $berth_run did not succeed: mise-berth:latest is not this release's (gh run view $berth_run --log-failed); nothing installed"
say "berth image run $berth_run: success; mise-berth:latest holds the calypso and chell just published"

for host in $HOSTS; do
  case "$host" in
    pangea)
      # Explicit versions beside porter (hoisted; porter resolves them); nothing removed first.
      npm install --prefix "$PANGEA_PREFIX" "@fnndsc/porter@$pv" $spec >/dev/null 2>&1 || die "pangea install failed; its tree is untouched"
      for p in argus brasa chell calypso porter; do printf '  pangea %-8s %s\n' "$p" "$(node -p "require('$PANGEA_PREFIX/node_modules/@fnndsc/$p/package.json').version")"; done
      systemctl --user restart porter && sleep 3 && say "pangea porter $(systemctl --user is-active porter)"
      ;;
    titan)
      # A global install replaces the tree, so root's npm must see every version first.
      ssh -o BatchMode=yes -o ConnectTimeout=15 "$TITAN" "for s in$spec @fnndsc/porter@$pv; do for i in \$(seq 1 40); do sudo -n npm view \$s version --prefer-online >/dev/null 2>&1 && break; sleep 15; done; done; sudo -n npm i -g @fnndsc/porter@$pv --prefer-online >/dev/null 2>&1 || { echo '[deploy] FAIL: titan install failed; its tree is kept'; exit 1; }; sudo -n systemctl restart porter && sleep 3 && echo \"[deploy] titan porter \$(systemctl is-active porter)\"; for p in argus brasa chell calypso; do printf '  titan  %-8s %s\n' \$p \"\$(node -p \"require('/usr/lib/node_modules/@fnndsc/porter/node_modules/@fnndsc/\$p/package.json').version\")\"; done; printf '  titan  %-8s %s\n' porter \"\$(node -p \"require('/usr/lib/node_modules/@fnndsc/porter/package.json').version\")\""
      ;;
    *) die "unknown host '$host' (pangea | titan)";;
  esac
done
say "done; sessions on old code restart once at their owner's next login"
