#!/usr/bin/env bash
# The upgrade path, live (#915 slice 3): a session's daemon running the
# previous published release, a porter from this checkout over the same
# state, and two logins. The first must restart the daemon exactly once
# onto this checkout's kernel; the second must attach without restarting.
# The class of bug that put an operator on yesterday's kernel twice in a day
# (law a-login-never-lands-on-an-older-kernel), checked end to end.
#
# Needs: ~/.config/mise/e2e.env (E2E_USER, E2E_PASSWORD, E2E_CUBE), the e2e
# identity's saved login at $SMOKE_SEED (default /tmp/pde2e/config), and a
# built checkout (`make cook`). Appends one line to the smoke ledger.
#
#   scripts/smoke-upgrade.sh              the previous published chell
#   OLD_CHELL=5.10.3 scripts/smoke-upgrade.sh
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
STATE=${SMOKE_STATE:-$HOME/.local/state/mise/smoke}
WORK=${UPGRADE_WORK:-/tmp/mise-upgrade}
PORT=${UPGRADE_PORT:-4192}   # not 4190: that one is on the fetch spec's blocked list
SEED=${SMOKE_SEED:-/tmp/pde2e/config}
day=$(date +%F)
ledger="$STATE/ledger.txt"
log="$STATE/$day-$(date +%H%M)-upgrade.log"
mkdir -p "$STATE"
exec 3>&1 > "$log" 2>&1

say() { printf '[upgrade] %s\n' "$*"; }
verdict() { echo "$day  upgrade  $*" | tee -a "$ledger" >&3; }
fail() { say "FAIL: $*"; verdict "FAIL: $* (see $log)"; cleanup; exit 1; }

set -a; . "$HOME/.config/mise/e2e.env"; set +a
[ -d "$SEED/@fnndsc" ] || { verdict "skipped: no e2e saved login at $SEED"; exit 0; }

NEW=$(node -p "require('./packages/chell/package.json').version")
OLD=${OLD_CHELL:-$(npm view @fnndsc/chell versions --json 2>/dev/null | node -e "
  const v = JSON.parse(require('fs').readFileSync(0, 'utf8')); const at = v.indexOf('$NEW');
  process.stdout.write(String(at > 0 ? v[at - 1] : v[v.length - 1] === '$NEW' ? v[v.length - 2] : v[v.length - 1]));")}
[ -n "$OLD" ] && [ "$OLD" != "$NEW" ] || { verdict "skipped: no published chell before $NEW to start from"; exit 0; }
say "old chell $OLD (published), new chell $NEW (this checkout)"

PORTER_PID=""; OLD_PID=""
cleanup() {
  [ -n "$PORTER_PID" ] && kill "$PORTER_PID" 2>/dev/null
  local berth; berth=$(find "$WORK/state" -name 'berth-*.json' 2>/dev/null | head -1)
  if [ -n "$berth" ]; then kill "$(node -p "require('$berth').pid")" 2>/dev/null; fi
  [ -n "$OLD_PID" ] && kill "$OLD_PID" 2>/dev/null
  true
}
trap cleanup EXIT

rm -rf "$WORK"; mkdir -p "$WORK/old" "$WORK/state"
npm install --prefix "$WORK/old" "@fnndsc/chell@$OLD" --no-audit --no-fund >/dev/null 2>&1 || fail "npm could not install chell $OLD"

CUBE=${E2E_CUBE%/}/
IDENTITY="$E2E_USER@$CUBE"
KEY=$(node --input-type=module -e "import { berthKey_compute } from '@fnndsc/calypso/berth'; process.stdout.write(berthKey_compute('$IDENTITY'));")
DIR="$WORK/state/$KEY"
mkdir -p "$DIR/config" "$DIR/run" "$DIR/cache" "$DIR/tmp"
cp -r "$SEED/@fnndsc" "$DIR/config/@fnndsc"

# 1. The old daemon, in the session's own directories, as an older porter left it.
TMPDIR=$DIR/tmp XDG_RUNTIME_DIR=$DIR/run XDG_CONFIG_HOME=$DIR/config XDG_CACHE_HOME=$DIR/cache \
  setsid nohup node "$WORK/old/node_modules/@fnndsc/chell/dist/index.js" "$E2E_USER@$E2E_CUBE" --daemon --saved-token --no-logo \
  > "$WORK/old-daemon.log" 2>&1 < /dev/null &
OLD_PID=$!
berth=""; for _ in $(seq 1 240); do berth=$(find "$DIR/run" -name 'berth-*.json' 2>/dev/null | head -1); [ -n "$berth" ] && break; sleep 1; done
[ -n "$berth" ] || fail "the old daemon never wrote its berth"
oldRunning=$(node -p "(require('$berth').versions || {}).chell || 'none'")
OLD_PID=$(node -p "require('$berth').pid")
say "old daemon up: pid $OLD_PID, berth says chell $oldRunning"
[ "$oldRunning" = "$OLD" ] || fail "the old daemon's berth says chell $oldRunning, expected $OLD"

# 2. A porter from this checkout over the same state; it adopts the old session.
PORTER_CUBE_URL="$E2E_CUBE" PORTER_PORT=$PORT PORTER_HOST=127.0.0.1 PORTER_STATE_DIR="$WORK/state" \
  PORTER_SECRET=$(head -c 24 /dev/urandom | base64) PORTER_CHELL="$ROOT/packages/chell/dist/index.js" \
  setsid nohup node apps/porter/dist/porter.js > "$WORK/porter.log" 2>&1 < /dev/null &
PORTER_PID=$!
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null || fail "the porter did not come up"
grep -q "adopted $E2E_USER's session" "$WORK/porter.log" || fail "the porter did not adopt the old session"

# The password goes in a 0600 file, never on a command line (law a-secret-is-never-on-the-command-line).
umask 077
node -e "require('fs').writeFileSync('$WORK/login.json', JSON.stringify({ username: process.env.E2E_USER, password: process.env.E2E_PASSWORD }))"
# A login says where it comes from, as a browser at this door would: the door takes a password only from itself.
login() { curl -s -c "$WORK/cj" -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" -d @"$WORK/login.json" "http://127.0.0.1:$PORT/login"; }

# 3. The first login: the door sees an older kernel and restarts it, once.
first=$(login); say "first login: $first"
echo "$first" | grep -q '"state":"starting"' || fail "the first login did not restart the old session ($first)"
timeout 300 curl -sN -b "$WORK/cj" -H 'accept: text/event-stream' "http://127.0.0.1:$PORT/boot/$KEY" > "$WORK/boot.sse" || true
grep -q '^event: ready' "$WORK/boot.sse" || fail "the restarted session did not boot to ready ($(grep -A1 '^event: failed' "$WORK/boot.sse" | tail -1))"
kill -0 "$OLD_PID" 2>/dev/null && fail "the old daemon (pid $OLD_PID) is still running after the restart"
berth=$(find "$DIR/run" -name 'berth-*.json' | head -1)
newRunning=$(node -p "(require('$berth').versions || {}).chell || 'none'")
say "after the restart the berth says chell $newRunning"
[ "$newRunning" = "$NEW" ] || fail "after the restart the kernel is chell $newRunning, not $NEW"

# 4. The second login: current now, so it attaches; no second restart.
second=$(login); say "second login: $second"
echo "$second" | grep -q '"state":"attached"' || fail "the second login did not attach ($second)"
restarts=$(grep -c "restarting $E2E_USER's session for the new release" "$WORK/porter.log")
[ "$restarts" = "1" ] || fail "the session restarted $restarts times, expected exactly once"
rm -f "$WORK/login.json" "$WORK/cj"

verdict "ok (chell $OLD → $NEW: one restart at the first login, the second attached, the old daemon gone)"
