#!/usr/bin/env bash
# The nightly: a fresh private daemon as the e2e identity, the whole ARGUS smoke
# against it at the desk width, then the listing stages again at a tablet width
# and under a finger, and one summary line appended to the ledger.
#
# A red here is a defect or a stale test, fixed the next day — never carried
# (epic #915). Read the ledger with `make smoke-report`. A red is also the
# script's exit status: any stage that fails, crashes, times out or leaves
# no summary, a door step that fails, or an upgrade step that fails, and the
# nightly exits 1, so the timer's unit reads failed and not finished.
#
# The stages and steps are functions, and the script can be sourced without
# running (SMOKE_NIGHTLY_SOURCED=1): scripts/smoke-nightly.test.sh drives
# them with stand-ins.
#
# Needs: ~/.config/mise/e2e.env (E2E_USER, E2E_PASSWORD, E2E_CUBE) and a built
# repo (`make cook`); runs from a systemd user timer on pangea (mise-smoke.timer).
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE=${SMOKE_STATE:-$HOME/.local/state/mise/smoke}
P=${SMOKE_PRIVATE:-/tmp/pde2e-nightly}
day=$(date +%F)
# One log per run, never one per day: a second run the same day (a rerun by
# hand) once overwrote the night's log and took its evidence with it.
log="$STATE/$day-$(date +%H%M).log"
ledger="$STATE/ledger.txt"
# How many stages and steps failed; the script's exit status is whether any did.
failures=0

daemon_start() { # extra env…: boots the private daemon, sets url and pid
  rm -f "$P"/run/calypso/berth-*.json
  env "$@" TMPDIR=$P/tmp XDG_RUNTIME_DIR=$P/run XDG_CONFIG_HOME=$P/config XDG_CACHE_HOME=$P/cache \
    setsid nohup node "$ROOT/packages/chell/dist/index.js" --daemon --no-logo --saved-token "$E2E_USER@$E2E_CUBE" > "$P/daemon.log" 2>&1 < /dev/null &
  b=""; for _ in $(seq 1 180); do b=$(ls "$P/run/calypso/" 2>/dev/null | grep berth- | head -1); [ -n "$b" ] && break; sleep 1; done
  [ -n "$b" ] || { echo "$day  no berth: the daemon did not boot" | tee -a "$ledger"; exit 1; }
  url=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['url'].replace('ws://','http://')+'/?token='+d['token'])" "$P/run/calypso/$b")
  pid=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$P/run/calypso/$b")
}
# One stage's verdict: its ledger line, its reds beneath, and whether it failed.
# A stage failed when its runner did (a failed scenario, a crash, 124 from
# `timeout`) or when its log holds no summary line, whatever the runner said.
run_record() { # name, runner's exit status, the stage's log
  local name=$1 status=$2 file=$3
  local line; line=$(grep -E '^[0-9]+ ok' "$file" 2>/dev/null | head -1 | cut -c1-400)
  echo "$day  $name  ${line:-no summary (crashed?)}" | tee -a "$ledger"
  grep -E '^\s+FAIL' "$file" 2>/dev/null | cut -c1-300 >> "$ledger" || true
  if [ "$status" -ne 0 ] || [ -z "$line" ]; then failures=$((failures + 1)); fi
}

run() { # name, port, extra env…
  local name=$1 port=$2; shift 2
  # A fresh browser every run: the profile holds localStorage (sized columns,
  # the landing), and a run that inherits last night's remembers what the
  # scenarios expect a new device to have forgotten.
  rm -rf "/tmp/smN/$name"
  env "$@" TMPDIR=/tmp/smN ARGUS_URL="$url" SMOKE_CDP_PORT="$port" SMOKE_CHROME_FLAGS="--no-sandbox --user-data-dir=/tmp/smN/$name" \
    timeout 2700 node apps/argus/tests/smoke/smoke.mjs > "$log.$name" 2>&1
  local status=$?
  run_record "$name" "$status" "$log.$name"
}
# The door's commands, as an operator's script runs them. Every command that
# fails is noted (the ERR trap) and the rest still run, so a login that
# fails is not hidden by a logout that works; the status is whether any
# failed. The one command meant to fail is checked for failing as it
# should, outside the lines the guide quotes. Call it as a
# command of its own, never on the left of && or ||: bash drops the trap
# there, as it drops `set -e`.
door_commands() (
  failed=0
  trap 'failed=1' ERR
  export XDG_CONFIG_HOME="$P/config"
  # tag::door-login[]
  # The operator mints a token for the identity by hand; the plaintext is shown once and carried on stdin.
  "$PORTER_BIN" --mint "$E2E_USER" --name "nightly@$(hostname -s)" | sed -n 2p \
    | node packages/chell/dist/index.js auth login --door "http://127.0.0.1:${PORTER_PORT:-4180}" --with-token
  # From here no flags are needed: this door is the default for this config.
  node packages/chell/dist/index.js auth status
  node packages/chell/dist/index.js -c pwd
  # end::door-login[]
  # -e stops a batch at its first error, and that is checked for what it is:
  # the cd is refused by name, the status is not zero, and the pwd after it
  # never ran. A batch that succeeds, or a crash that says nothing of the
  # cd, is not that.
  stopped_said=$(node packages/chell/dist/index.js -e -c "cd /nowhere; pwd" 2>&1) && stopped=0 || stopped=$?
  printf '%s\n' "$stopped_said"
  if [ "$stopped" -eq 0 ]; then echo "door: the -e batch went on past its error (exit 0)"; failed=1; fi
  case "$stopped_said" in *"cd: /nowhere"*) ;; *) echo "door: the -e batch did not refuse the cd by name"; failed=1 ;; esac
  if printf '%s\n' "$stopped_said" | grep -q '^/'; then echo "door: the pwd after the refused cd ran"; failed=1; fi
  # tag::door-login[]
  node packages/chell/dist/index.js auth logout
  # end::door-login[]
  exit "$failed"
)

# The door, scripted (#925): a token minted by the operator's hand lets a
# script in with no password anywhere, and `chell -c` goes through the
# default door with no flags. Against this host's own porter (loopback, so
# a token may travel over plain http). Skipped, and said, while the
# installed porter is older than door tokens.
door_step() {
  PORTER_BIN=${PORTER_BIN:-$HOME/.local/share/porter-published/node_modules/.bin/porter}
  local env_file=${PORTER_ENV:-$HOME/.config/porter.env}
  [ -f "$env_file" ] && [ -x "$PORTER_BIN" ] || return 0
  set -a; . "$env_file"; set +a
  local door_log="$STATE/$day-door.log"
  # A porter from before door tokens refuses the word itself, and says so;
  # that is the one skip. Any other failure of the probe is a porter that
  # has tokens and could not list them, which is a red.
  local probe probed
  probe=$("$PORTER_BIN" --tokens 2>&1) && probed=0 || probed=$?
  if [ "$probed" -ne 0 ]; then
    if printf '%s' "$probe" | grep -qF "unknown word '--tokens'"; then
      echo "$day  door  skipped: the installed porter has no door tokens yet" | tee -a "$ledger"
      return 0
    fi
    # The probe's own words may name tokens: they go to the door's log, not the ledger.
    printf '%s\n' "$probe" > "$door_log"
    echo "$day  door  FAIL (the porter could not list its door tokens, exit $probed; see $door_log)" | tee -a "$ledger"
    failures=$((failures + 1))
    return 0
  fi
  door_commands > "$door_log" 2>&1
  local status=$?
  if [ "$status" -eq 0 ]; then
    echo "$day  door  ok (mint, login by token, status, chell -c, -e, logout)" | tee -a "$ledger"
  else
    echo "$day  door  FAIL (see $door_log)" | tee -a "$ledger"
    tail -5 "$door_log" | cut -c1-300 >> "$ledger"
    failures=$((failures + 1))
  fi
}

# The upgrade path (#915): a daemon on the previous published release, a
# porter from this checkout, two logins; one line in the ledger of its own.
upgrade_step() {
  bash "${SMOKE_UPGRADE:-$ROOT/scripts/smoke-upgrade.sh}"
  local status=$?
  if [ "$status" -ne 0 ]; then failures=$((failures + 1)); fi
}

# The run's last line in the ledger, and its verdict as a status.
nightly_finish() {
  echo "$day  log $log" >> "$ledger"
  [ "$failures" -eq 0 ]
}

nightly_main() {
  cd "$ROOT" || exit 1
  mkdir -p "$STATE" "$P/tmp" "$P/run" "$P/config" "$P/cache" /tmp/smN
  # A private daemon of our own: its own XDG dirs (cwd.txt and proc shards are per identity).
  set -a; . "$HOME/.config/mise/e2e.env"; set +a
  # The daemon logs in with the e2e identity's SAVED token, seeded from the
  # config the e2e daemon keeps (SMOKE_SEED, default /tmp/pde2e/config): a
  # password on a command line would show in every ps on this host.
  SEED=${SMOKE_SEED:-/tmp/pde2e/config}
  [ -d "$SEED/@fnndsc" ] || { echo "$day  no e2e seed at $SEED/@fnndsc: log the e2e identity in once (restart-e2e) and run again" | tee -a "$ledger"; exit 1; }
  rm -rf "$P/config/@fnndsc" && cp -r "$SEED/@fnndsc" "$P/config/@fnndsc"
  daemon_start
  run desk 9701
  run tablet 9702 SMOKE_ONLY=listing-columns,mode-frame,cards,runs-honesty,roster-order,notes SMOKE_WIDTH=1024 SMOKE_HEIGHT=768
  run finger 9703 SMOKE_ONLY=listing-columns,mode-frame,cards,notes SMOKE_WIDTH=1024 SMOKE_HEIGHT=768 SMOKE_TOUCH=1
  kill "$pid" 2>/dev/null || true
  # The console is a terminal (#1125); the transcript is the deprecated fallback
  # for a daemon without a pty. A daemon made one (CALYPSO_NO_PTY=1) runs its
  # own scenarios, so the fallback stays honest while it lasts.
  sleep 2
  daemon_start CALYPSO_NO_PTY=1
  run transcript 9704 SMOKE_CONSOLE=transcript SMOKE_ONLY=console-grammar,console-height,console-zoom,console-asks,question-both-places,pane-ask,ask-errand
  kill "$pid" 2>/dev/null || true
  cat "$log".desk "$log".tablet "$log".finger "$log".transcript > "$log" 2>/dev/null; rm -f "$log".desk "$log".tablet "$log".finger "$log".transcript
  door_step
  upgrade_step
  nightly_finish
}

if [ "${SMOKE_NIGHTLY_SOURCED:-0}" != 1 ]; then
  nightly_main
  exit $?
fi
