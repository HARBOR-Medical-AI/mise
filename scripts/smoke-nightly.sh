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
# Everything the run makes while it runs (the private daemon's folders, the
# browsers' profiles, the token it logs in with) is under one folder that is
# this run's alone: made by mktemp, mode 0700, under the user's runtime
# folder, and removed when the run ends, however it ends. Nothing of a run
# is under a name in /tmp that another user could have made first. The
# ledger and the logs are kept, under the state folder. SMOKE_PRIVATE names
# a folder to use instead, for a person debugging; it must be private, and
# is left as it is.
#
# The daemon logs in as the e2e identity with a token CUBE issues for the
# run: no saved login is kept or copied between runs.
#
# Needs: ~/.config/mise/e2e.env (E2E_USER, E2E_PASSWORD, E2E_CUBE), readable
# by this user alone, and a built repo (`make cook`); runs from a systemd
# user timer on pangea (mise-smoke.timer).
# A password the caller's environment came with is dropped before anything at all is run: the credentials
# file is the one source, and is read only for the one command that needs it.
unset E2E_PASSWORD
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/smoke-private.sh
. "$ROOT/scripts/lib/smoke-private.sh"
STATE=${SMOKE_STATE:-$HOME/.local/state/mise/smoke}
# The run's folder. Settled in nightly_main; a script that sources this to
# drive its functions names the folder itself (SMOKE_PRIVATE).
P=${SMOKE_PRIVATE:-}
day=$(date +%F)
# One log per run, never one per day: a second run the same day (a rerun by
# hand) once overwrote the night's log and took its evidence with it.
log="$STATE/$day-$(date +%H%M).log"
ledger="$STATE/ledger.txt"
# How many stages and steps failed; the script's exit status is whether any did.
failures=0

daemon_start() { # extra env…: boots the private daemon, sets url and pid
  rm -f "$P"/run/calypso/berth-*.json
  # A token from CUBE for this daemon, in a file of the run's own, handed over on standard input: no
  # password and no token is on a command line, and no login saved by another run is read.
  cube_token_get "$P" > "$P/token" || { echo "$day  no token: CUBE did not issue one for the e2e identity" | tee -a "$ledger"; exit 1; }
  env "$@" "TMPDIR=$P/tmp" "XDG_RUNTIME_DIR=$P/run" "XDG_CONFIG_HOME=$P/config" "XDG_CACHE_HOME=$P/cache" \
    setsid nohup node "$ROOT/packages/chell/dist/index.js" "$E2E_USER@$E2E_CUBE" --daemon --no-logo --auth-token-stdin > "$P/daemon.log" 2>&1 < "$P/token" &
  daemon_note $!
  b=""; for _ in $(seq 1 180); do b=$(ls "$P/run/calypso/" 2>/dev/null | grep berth- | head -1); [ -n "$b" ] && break; sleep 1; done
  rm -f "$P/token"
  [ -n "$b" ] || { echo "$day  no berth: the daemon did not boot" | tee -a "$ledger"; exit 1; }
  url=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['url'].replace('ws://','http://')+'/?token='+d['token'])" "$P/run/calypso/$b")
  pid=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$P/run/calypso/$b")
  # The berth's process is the run's own on proof: its environment names this run's folder.
  daemon_note_owned "$pid" "XDG_RUNTIME_DIR=$P/run" || { echo "$day  the berth names a process that is not this run's daemon (pid $pid)" | tee -a "$ledger"; exit 1; }
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
  # The profile and the fixtures are under the run's own folder, which is new each run.
  # --no-sandbox: the browser on this host is started so by every smoke run (the sandbox needs a host
  # setting this script cannot make); it loads only the private daemon's own page.
  mkdir -p "$P/browser/$name"
  env "$@" "TMPDIR=$P/browser" "ARGUS_URL=$url" "SMOKE_CDP_PORT=$port" SMOKE_CHROME_FLAGS=--no-sandbox "SMOKE_PROFILE_DIR=$P/browser/$name" \
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
  # the cd is refused by name, the status is 1, and the pwd after it never
  # ran. A batch that succeeds, or a crash, is not that.
  stopped_said=$(node packages/chell/dist/index.js -e -c "cd /nowhere; pwd" 2>&1) && stopped=0 || stopped=$?
  printf '%s\n' "$stopped_said"
  # chell's status for a refused line is 1. Anything else is not a batch that
  # stopped: 0 went on, and a larger number is a crash, whatever it printed first.
  if [ "$stopped" -ne 1 ]; then echo "door: the -e batch ended with status $stopped, where a stop at its first error is 1"; failed=1; fi
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
  # In a shell of its own: the porter's environment file holds its signing secret, which is exported for
  # the porter's own words here and reaches nothing the run starts afterwards.
  # Run as a command of its own, never as one side of `||`: there the door commands' trap on a failing
  # command would not fire, and a failed login would be written down as ok.
  ( door_step_scoped )
  local status=$?
  [ "$status" -eq 0 ] || failures=$((failures + 1))
}
door_step_scoped() {
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
    return 1
  fi
  door_commands > "$door_log" 2>&1
  local status=$?
  if [ "$status" -eq 0 ]; then
    echo "$day  door  ok (mint, login by token, status, chell -c, -e, logout)" | tee -a "$ledger"
  else
    echo "$day  door  FAIL (see $door_log)" | tee -a "$ledger"
    tail -5 "$door_log" | cut -c1-300 >> "$ledger"
    return 1
  fi
}

# The upgrade path (#915): a daemon on the previous published release, a
# porter from this checkout, two logins; one line in the ledger of its own.
upgrade_step() {
  # It works in a folder inside this run's own, which stays this run's to remove.
  # Marked as running before it is started and until its status has been read here. A signal that arrives
  # while this shell waits for it is acted on the moment it returns, before the next line can read how it
  # ended: the ending then finds the mark, and keeps the folder, since the step may have had to leave its
  # own as it was and nothing here has heard.
  UPGRADE_IN_FLIGHT=1
  SMOKE_RUN_ROOT="$P" bash "${SMOKE_UPGRADE:-$ROOT/scripts/smoke-upgrade.sh}"
  local status=$?
  if [ "$status" -ne 0 ]; then failures=$((failures + 1)); fi
  # It could not finish its own ending, and left its folder as it was: this run's folder, which holds it,
  # is kept too. The reason is in the upgrade's own line in the ledger.
  if [ "$status" -eq "$KEEP_STATUS" ]; then run_root_keep "the upgrade step left its folder as it was"; fi
  # Ended by a signal (a status above 128): its own ending may never have run, so what it started may still
  # be running and its list of that is in its folder. Said, with the status, and the folder kept.
  if [ "$status" -gt 128 ]; then
    echo "$day  upgrade  FAIL: the upgrade step was ended by a signal (status $status); whether it stopped what it started is not known" | tee -a "$ledger"
    run_root_keep "the upgrade step was ended by a signal (status $status)"
  fi
  UPGRADE_IN_FLIGHT=0
}

# The run's last line in the ledger, and its verdict as a status.
nightly_finish() {
  echo "$day  log $log" >> "$ledger"
  [ "$failures" -eq 0 ]
}

# How the run ends, however it ends: what it started is stopped and waited
# for, then its folder is removed if the run made it, and the status the
# run had is the status it leaves with.
nightly_ending() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "${RUN_ROOT:-}" ]; then
    local stopped=0
    # The run ended while the upgrade step was running, with its status never read: how that step left its
    # folder is not known here, so the folder that holds it is kept.
    if [ "${UPGRADE_IN_FLIGHT:-0}" = 1 ]; then run_root_keep "the run ended while the upgrade step was running, and how that step left its folder is not known"; fi
    daemons_reap || stopped=1
    # No secret outlives the run, whether or not its folder does: after what could write one is stopped.
    secrets_remove "$RUN_ROOT" || { echo "$day  credentials the run made could not be removed from $RUN_ROOT" | tee -a "$ledger"; [ "$status" -eq 0 ] && status=1; }
    if [ "$stopped" -ne 0 ]; then
      # Something the run started could not be stopped: said, counted as a failure, and the folder kept,
      # with the list of what it started, for whoever has to stop it by hand.
      echo "$day  could not stop what the run started (pid $DAEMONS_LEFT); its folder is kept at $RUN_ROOT" | tee -a "$ledger"
      [ "$status" -eq 0 ] && status=1
    elif ! run_root_remove; then
      # A step working inside the folder could not stop what it started, and asked for it to be kept.
      echo "$day  the run's folder is kept at $RUN_ROOT ($RUN_ROOT_KEPT)" | tee -a "$ledger"
      [ "$status" -eq 0 ] && status=1
    fi
  fi
  exit "$status"
}
# A signal is a failure by itself, whatever the command it interrupted had
# returned: said in the ledger, and the run leaves with a failing status.
nightly_interrupted() { # the signal's name
  failures=$((failures + 1))
  echo "$day  interrupted ($1): the run did not finish" >> "$ledger"
  echo "$day  log $log" >> "$ledger"
  exit 1
}

nightly_main() {
  cd "$ROOT" || exit 1
  umask 077
  mkdir -p "$STATE"
  # The credentials are this user's alone, or the run does not start.
  # The credentials: a file of this user's alone that reads without error and names all three. The user and
  # the CUBE are taken into the environment; the password is not, and is given only to the one command that
  # writes a login payload.
  credentials_load "${E2E_ENV:-$HOME/.config/mise/e2e.env}" || { echo "$day  not started: $CREDENTIALS_SAID" | tee -a "$ledger"; exit 1; }
  run_root_settle "" "" "${SMOKE_PRIVATE:-}" mise-smoke-nightly || { echo "$day  not started: $RUN_ROOT_SAID" | tee -a "$ledger"; exit 1; }
  P=$RUN_ROOT
  trap nightly_ending EXIT
  trap 'nightly_interrupted INT' INT
  trap 'nightly_interrupted TERM' TERM
  mkdir -p "$P/tmp" "$P/run" "$P/config" "$P/cache" "$P/browser"
  # A private daemon of our own: its own XDG dirs (cwd.txt and proc shards are per identity).
  daemon_start
  run desk 9701
  run tablet 9702 SMOKE_ONLY=listing-columns,mode-frame,cards,runs-honesty,roster-order,notes SMOKE_WIDTH=1024 SMOKE_HEIGHT=768
  run finger 9703 SMOKE_ONLY=listing-columns,mode-frame,cards,notes SMOKE_WIDTH=1024 SMOKE_HEIGHT=768 SMOKE_TOUCH=1
  # Stopped as the process it was noted as, never by its pid alone; one that will not stop ends the run.
  daemons_stop "$pid" || { echo "$day  the daemon (pid $pid) could not be stopped" | tee -a "$ledger"; exit 1; }
  # The console is a terminal (#1125); the transcript is the deprecated fallback
  # for a daemon without a pty. A daemon made one (CALYPSO_NO_PTY=1) runs its
  # own scenarios, so the fallback stays honest while it lasts.
  sleep 2
  daemon_start CALYPSO_NO_PTY=1
  run transcript 9704 SMOKE_CONSOLE=transcript SMOKE_ONLY=console-grammar,console-height,console-zoom,console-asks,question-both-places,pane-ask,ask-errand
  # Stopped as the process it was noted as, never by its pid alone; one that will not stop ends the run.
  daemons_stop "$pid" || { echo "$day  the daemon (pid $pid) could not be stopped" | tee -a "$ledger"; exit 1; }
  cat "$log".desk "$log".tablet "$log".finger "$log".transcript > "$log" 2>/dev/null; rm -f "$log".desk "$log".tablet "$log".finger "$log".transcript
  door_step
  upgrade_step
  nightly_finish
}

if [ "${SMOKE_NIGHTLY_SOURCED:-0}" != 1 ]; then
  nightly_main
  exit $?
fi
