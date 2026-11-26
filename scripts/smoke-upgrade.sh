#!/usr/bin/env bash
# The upgrade path, live (#915 slice 3): a session's daemon running the
# previous published release, a porter from this checkout over the same
# state, and two logins. The first must restart the daemon exactly once
# onto this checkout's kernel; the second must attach without restarting.
# The class of bug that put an operator on yesterday's kernel twice in a day
# (law a-login-never-lands-on-an-older-kernel), checked end to end.
#
# Needs: ~/.config/mise/e2e.env (E2E_USER, E2E_PASSWORD, E2E_CUBE), readable
# by this user alone, and a built checkout (`make cook`). Appends one line
# to the smoke ledger. The old daemon is logged in with a token CUBE issues
# for the run, on its standard input: no saved login is read or copied.
#
# Everything it makes while it runs is under a folder of its own: inside the
# nightly's when the nightly runs it (SMOKE_RUN_ROOT, the nightly's to
# remove), else a new one from mktemp, mode 0700, removed when the run ends.
# UPGRADE_WORK names a folder to work inside instead, for a person debugging;
# it must be private, and is left, without the credentials the run made.
# UPGRADE_PORTER names another porter entry to run (the tests' stand-in).
#
# A run that cannot do its work is a failure, not a skip: with nothing
# published to start from, or a previous release that cannot be logged in
# this way, it says so in the ledger and exits 1.
#
#   scripts/smoke-upgrade.sh              the previous published chell
#   OLD_CHELL=5.10.3 scripts/smoke-upgrade.sh   that release, and no other
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
# shellcheck source=scripts/lib/smoke-private.sh
. "$ROOT/scripts/lib/smoke-private.sh"
umask 077
STATE=${SMOKE_STATE:-$HOME/.local/state/mise/smoke}
PORT=${UPGRADE_PORT:-4192}   # not 4190: that one is on the fetch spec's blocked list
CREDENTIALS=${E2E_ENV:-$HOME/.config/mise/e2e.env}
day=$(date +%F)
ledger="$STATE/ledger.txt"
log="$STATE/$day-$(date +%H%M)-upgrade.log"
mkdir -p "$STATE"
exec 3>&1 > "$log" 2>&1

say() { printf '[upgrade] %s\n' "$*"; }
verdict() { echo "$day  upgrade  $*" | tee -a "$ledger" >&3; }
# The run's verdict so far, as the status it will leave with.
status=0
fail() { say "FAIL: $*"; verdict "FAIL: $* (see $log)"; status=1; exit 1; }

# How the run ends, however it ends: the porter, the old daemon and the
# daemon the porter started are stopped and waited for; the folder is
# removed if this run made it; and the status is the run's own.
PORTER_PID=""
WORK=""
DIR=""
ending() {
  local left=$?
  trap - EXIT INT TERM
  [ "$status" -eq 0 ] && status=$left
  if [ -n "$WORK" ]; then
    local stopped=0
    # The porter first: it is what starts daemons, and stopped it starts no more.
    daemons_stop ${PORTER_PID:+"$PORTER_PID"} || stopped=1
    # Then whatever it started, found by what proves it the run's (its environment names this run's own
    # session folder), whether or not it had yet written the berth it would be known by.
    [ -n "$DIR" ] && daemons_note_proven "XDG_RUNTIME_DIR=$DIR/run"
    daemons_reap || stopped=1
    # No secret outlives the run, whether or not its folder does.
    secrets_remove "$WORK" || { say "a credential store could not be removed from $WORK"; verdict "FAIL: credentials the run made could not be removed from $WORK (see $log)"; status=1; }
    if [ "$stopped" -eq 0 ]; then
      run_root_remove
    else
      # Something the run started could not be stopped: a failure, said, with the folder and its list of
      # what was started kept for whoever has to stop it by hand; a parent that handed the folder down is
      # told to keep it too.
      say "could not stop pid $DAEMONS_LEFT"
      verdict "FAIL: could not stop what the run started (pid $DAEMONS_LEFT); its folder is kept at $WORK (see $log)"
      [ -n "${SMOKE_RUN_ROOT:-}" ] && run_root_keep "$SMOKE_RUN_ROOT" "the upgrade could not stop pid $DAEMONS_LEFT; see $WORK"
      status=1
    fi
  fi
  exit "$status"
}
# A signal is a failure by itself, whatever the command it interrupted had returned.
interrupted() { # the signal's name
  status=1
  say "interrupted ($1)"
  verdict "FAIL: interrupted ($1): the run did not finish (see $log)"
  exit 1
}
trap ending EXIT
trap 'interrupted INT' INT
trap 'interrupted TERM' TERM

# The credentials: a file of this user's alone that reads without error and names all three, or nothing is
# started. The user and the CUBE are taken into the environment; the password is not: npm and what it
# installs, the daemons and the porter never have it. It is given only to the command that writes a login
# payload.
credentials_load "$CREDENTIALS" || fail "not started: $CREDENTIALS_SAID"

run_root_settle "${SMOKE_RUN_ROOT:-}" upgrade "${UPGRADE_WORK:-}" mise-smoke-upgrade || fail "not started: $RUN_ROOT_SAID"
WORK=$RUN_ROOT

NEW=$(node -p "require('./packages/chell/package.json').version")
# The release to start from: the one named, or the newest published before this checkout's. That one is
# run, or the run fails by name; another is never put in its place.
if [ -n "${OLD_CHELL:-}" ]; then
  OLD=$OLD_CHELL
else
  # The greatest published version strictly below this checkout's, by its numbers: never one above it,
  # whether or not this checkout's own version is published.
  OLD=$(npm view @fnndsc/chell versions --json 2>/dev/null | version_before "$NEW") || OLD=""
fi
[ -n "$OLD" ] && [ "$OLD" != "$NEW" ] || fail "no published chell before $NEW to start from"
say "old chell $OLD (published), new chell $NEW (this checkout)"

mkdir -p "$WORK/old" "$WORK/state"
npm install --prefix "$WORK/old" "@fnndsc/chell@$OLD" --no-audit --no-fund >/dev/null 2>&1 || fail "npm could not install chell $OLD"
OLD_ENTRY="$WORK/old/node_modules/@fnndsc/chell/dist/index.js"
# The old release is logged in with a token on its standard input. One from before that way in cannot be
# started without a saved login, which this run does not keep: said by name, as a failure.
grep -rqF -- '--auth-token-stdin' "$WORK/old/node_modules/@fnndsc/chell/dist" || fail "chell $OLD cannot be logged in without a saved login (it has no --auth-token-stdin); the upgrade from it was not run"

CUBE=${E2E_CUBE%/}/
IDENTITY="$E2E_USER@$CUBE"
KEY=$(node --input-type=module -e "import { berthKey_compute } from '@fnndsc/calypso/berth'; process.stdout.write(berthKey_compute(process.argv[1]));" "$IDENTITY")
DIR="$WORK/state/$KEY"
mkdir -p "$DIR/config" "$DIR/run" "$DIR/cache" "$DIR/tmp"

# 1. The old daemon, in the session's own directories, as an older porter left it.
cube_token_get "$WORK" > "$WORK/token" || fail "CUBE did not issue a token for the e2e identity"
TMPDIR="$DIR/tmp" XDG_RUNTIME_DIR="$DIR/run" XDG_CONFIG_HOME="$DIR/config" XDG_CACHE_HOME="$DIR/cache" \
  setsid nohup node "$OLD_ENTRY" "$E2E_USER@$E2E_CUBE" --daemon --auth-token-stdin --no-logo \
  > "$WORK/old-daemon.log" 2>&1 < "$WORK/token" &
daemon_note $!
berth=""; for _ in $(seq 1 240); do berth=$(find "$DIR/run" -name 'berth-*.json' 2>/dev/null | head -1); [ -n "$berth" ] && break; sleep 1; done
rm -f "$WORK/token"
[ -n "$berth" ] || fail "the old daemon never wrote its berth"
oldRunning=$(node -p "(require(process.argv[1]).versions || {}).chell || 'none'" "$berth")
OLD_PID=$(node -p "require(process.argv[1]).pid" "$berth")
daemon_note_owned "$OLD_PID" "XDG_RUNTIME_DIR=$DIR/run" || fail "the old daemon's berth names a process that is not this run's"
say "old daemon up: pid $OLD_PID, berth says chell $oldRunning"
[ "$oldRunning" = "$OLD" ] || fail "the old daemon's berth says chell $oldRunning, expected $OLD"

# 2. A porter from this checkout over the same state; it adopts the old session.
PORTER_CUBE_URL="$E2E_CUBE" PORTER_PORT=$PORT PORTER_HOST=127.0.0.1 PORTER_STATE_DIR="$WORK/state" \
  PORTER_SECRET=$(head -c 24 /dev/urandom | base64) PORTER_CHELL="$ROOT/packages/chell/dist/index.js" \
  setsid nohup node "${UPGRADE_PORTER:-apps/porter/dist/porter.js}" > "$WORK/porter.log" 2>&1 < /dev/null &
PORTER_PID=$!
daemon_note "$PORTER_PID"
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null || fail "the porter did not come up"
grep -q "adopted $E2E_USER's session" "$WORK/porter.log" || fail "the porter did not adopt the old session"

# The password goes in a 0600 file, never on a command line (law a-secret-is-never-on-the-command-line).
login_payload_write "$WORK/login.json" || fail "the login payload could not be written"
# A login says where it comes from, as a browser at this door would: the door takes a password only from itself.
login() { curl -s -c "$WORK/cj" -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" -d @"$WORK/login.json" "http://127.0.0.1:$PORT/login"; }

# 3. The first login: the door sees an older kernel and restarts it, once.
first=$(login); say "first login: $first"
echo "$first" | grep -q '"state":"starting"' || fail "the first login did not restart the old session ($first)"
timeout 300 curl -sN -b "$WORK/cj" -H 'accept: text/event-stream' "http://127.0.0.1:$PORT/boot/$KEY" > "$WORK/boot.sse" || true
grep -q '^event: ready' "$WORK/boot.sse" || fail "the restarted session did not boot to ready ($(grep -A1 '^event: failed' "$WORK/boot.sse" | tail -1))"
kill -0 "$OLD_PID" 2>/dev/null && fail "the old daemon (pid $OLD_PID) is still running after the restart"
berth=$(find "$DIR/run" -name 'berth-*.json' | head -1)
# The daemon the porter started, ready: noted now as the run's, on the proof of its environment.
daemon_note_owned "$(node -p "require(process.argv[1]).pid" "$berth")" "XDG_RUNTIME_DIR=$DIR/run" || fail "the restarted daemon is not in this run's own folders"
newRunning=$(node -p "(require(process.argv[1]).versions || {}).chell || 'none'" "$berth")
say "after the restart the berth says chell $newRunning"
[ "$newRunning" = "$NEW" ] || fail "after the restart the kernel is chell $newRunning, not $NEW"

# 4. The second login: current now, so it attaches; no second restart.
second=$(login); say "second login: $second"
echo "$second" | grep -q '"state":"attached"' || fail "the second login did not attach ($second)"
restarts=$(grep -c "restarting $E2E_USER's session for the new release" "$WORK/porter.log")
[ "$restarts" = "1" ] || fail "the session restarted $restarts times, expected exactly once"
rm -f "$WORK/login.json" "$WORK/cj"

verdict "ok (chell $OLD → $NEW: one restart at the first login, the second attached, the old daemon gone)"
