#!/usr/bin/env bash
# The nightly's and the upgrade smoke's private folders, credentials and
# endings, driven with stand-ins.
#
#   - scripts/lib/smoke-private.sh, function by function: what is private
#     and what is not; the three ways a run's folder is settled and which
#     of them the run may remove; a noted process stopped, and one that
#     only shares a noted pid left alone.
#   - scripts/smoke-upgrade.sh, the script itself, with stand-ins first on
#     PATH for npm, curl and the old release: credentials others can read
#     stop it; a named folder others can reach stops it; a previous release
#     that cannot take a token fails by name and starts nothing; a set-up
#     that fails after the old daemon is up leaves no process of the run
#     and no folder of its own; a TERM mid-run is a failure by itself; a
#     folder handed down by the nightly is still there afterwards.
#   - scripts/smoke-nightly.sh's entry: credentials others can read stop it
#     before anything is started.
#
# Every folder it makes is new, under ${TMPDIR:-/tmp}, and is left there: this
# script deletes nothing. (The runs it drives remove the folders they made
# themselves, which is what is being checked.)
#
# Run: bash scripts/smoke-private.test.sh   (exits 1 when any case fails)
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/smoke-private-test.XXXXXX")
chmod 700 "$WORK"
BIN="$WORK/bin"
mkdir -p "$BIN"
failed_cases=0
cases=0

ok() { cases=$((cases + 1)); echo "  ok    $1"; }
bad() { cases=$((cases + 1)); failed_cases=$((failed_cases + 1)); echo "  FAIL  $1"; }
check() { # what, then a command that must succeed
  local what=$1; shift
  if "$@"; then ok "$what"; else bad "$what"; fi
}

# shellcheck source=scripts/lib/smoke-private.sh
. "$HERE/lib/smoke-private.sh"

echo "what is private"
mkdir -m 700 "$WORK/mine"; touch "$WORK/mine/secret"; chmod 600 "$WORK/mine/secret"
check "a 0600 file of this user's is private" private_check "$WORK/mine/secret" "it"
check "a 0700 folder of this user's is private" private_check "$WORK/mine" "it"
for mode in 644 640 604 660 606; do
  touch "$WORK/mine/open-$mode"; chmod "$mode" "$WORK/mine/open-$mode"
  if said=$(private_check "$WORK/mine/open-$mode" "the file"); then bad "a $mode file is not private"; else
    case "$said" in *"has mode $mode"*) ok "a $mode file is refused, with its mode" ;; *) bad "a $mode file was refused without its mode: $said" ;; esac
  fi
done
mkdir -m 755 "$WORK/mine/open-folder"
if private_check "$WORK/mine/open-folder" "it" > /dev/null; then bad "a 0755 folder is not private"; else ok "a 0755 folder is refused"; fi
if private_check "$WORK/mine/no-such" "it" > /dev/null; then bad "a missing file is not private"; else ok "a missing file is refused"; fi
# Another user's file: this user is made to look like another, by a stand-in `id` first on PATH.
mkdir "$WORK/other-bin"; printf '#!/usr/bin/env bash\nif [ "$1" = -u ]; then echo 4242; else exec /usr/bin/id "$@"; fi\n' > "$WORK/other-bin/id"; chmod +x "$WORK/other-bin/id"
if said=$(PATH="$WORK/other-bin:$PATH" private_check "$WORK/mine/secret" "the file"); then bad "another user's file is not private"; else
  case "$said" in *"is owned by user"*) ok "a file owned by another user is refused, by its owner" ;; *) bad "another user's file was refused without saying whose: $said" ;; esac
fi

echo "the run's folder"
runtime="$WORK/runtime"; mkdir -m 700 "$runtime"
( XDG_RUNTIME_DIR="$runtime"; run_root_settle "" "" "" mise-smoke-nightly && [ "$RUN_ROOT_OWNED" = 1 ] && [ "$(stat -c %a "$RUN_ROOT")" = 700 ] && [ "$(dirname "$RUN_ROOT")" = "$runtime" ] \
  && run_root_remove && [ ! -e "$RUN_ROOT" ] ) && ok "with nothing named: a new 0700 folder under the runtime folder, the run's own, and removed by it" || bad "with nothing named: a new 0700 folder of the run's own"
mkdir -m 700 "$WORK/parent"
( run_root_settle "$WORK/parent" upgrade "" mise-smoke-upgrade && [ "$RUN_ROOT" = "$WORK/parent/upgrade" ] && [ "$RUN_ROOT_OWNED" = 0 ] && run_root_remove && [ -d "$RUN_ROOT" ] ) \
  && ok "handed a folder by a parent: a folder inside it, and not this run's to remove" || bad "handed a folder by a parent"
mkdir -m 755 "$WORK/open-parent"
( run_root_settle "$WORK/open-parent" upgrade "" mise-smoke-upgrade ) > /dev/null 2>&1 && bad "a parent's folder others can reach is refused" || ok "a parent's folder others can reach is refused"
mkdir -m 700 "$WORK/named"; touch "$WORK/named/from-before"
( run_root_settle "" "" "$WORK/named" mise-smoke-nightly && [ "$RUN_ROOT_OWNED" = 0 ] && [ "$(dirname "$RUN_ROOT")" = "$WORK/named" ] && [ "$(stat -c %a "$RUN_ROOT")" = 700 ] && run_root_remove && [ -d "$RUN_ROOT" ] && [ -e "$WORK/named/from-before" ] ) \
  && ok "a folder named by a person: a folder of this run inside it, never removed, what was there left alone" || bad "a folder named by a person"
( run_root_settle "" "" "$WORK/named-new" mise-smoke-nightly && [ "$(stat -c %a "$WORK/named-new")" = 700 ] && [ "$RUN_ROOT_OWNED" = 0 ] ) && ok "a named folder that is not there is made 0700" || bad "a named folder that is not there is made 0700"
mkdir -m 755 "$WORK/named-open"
( run_root_settle "" "" "$WORK/named-open" mise-smoke-nightly; status=$?; [ "$status" -ne 0 ] && case "$RUN_ROOT_SAID" in *"has mode 755"*) exit 0 ;; *) exit 1 ;; esac ) \
  && ok "a named folder others can reach is refused, with its mode" || bad "a named folder others can reach is refused, with its mode"
# Only a folder mktemp made under the expected name is ever removed.
( RUN_ROOT="$WORK/mine"; RUN_ROOT_OWNED=1; run_root_remove; [ -d "$WORK/mine" ] ) && ok "a folder not named as mktemp names the run's is not removed, whatever is claimed" || bad "a folder with another name was removed"

echo "what the run started"
(
  RUN_ROOT="$WORK/reap"; mkdir -m 700 "$RUN_ROOT"
  sleep 300 & noted=$!
  sleep 300 & bystander=$!
  daemon_note "$noted"
  # The bystander's pid with a start time that is not its own: a pid the run once noted, since given to another process.
  echo "$bystander 1" >> "$RUN_ROOT/started.pids"
  daemons_reap
  if kill -0 "$noted" 2>/dev/null; then echo "the noted process is still running"; kill "$noted" "$bystander"; exit 1; fi
  if ! kill -0 "$bystander" 2>/dev/null; then echo "a process that only shared a noted pid was stopped"; exit 1; fi
  kill "$bystander"
) > "$WORK/reap.txt" 2>&1 && ok "a noted process is stopped; one that only has a noted pid is left alone" || bad "reaping: $(cat "$WORK/reap.txt")"
(
  RUN_ROOT="$WORK/reap-stubborn"; mkdir -m 700 "$RUN_ROOT"
  # It ignores being asked, and holds no child for longer than a second.
  bash -c 'trap "" TERM; for _ in $(seq 1 300); do sleep 1; done' & stubborn=$!
  sleep 0.3
  daemon_note "$stubborn"
  daemons_reap
  # Killed, it is this shell's to collect; until then its pid still answers.
  wait "$stubborn" 2>/dev/null
  ! kill -0 "$stubborn" 2>/dev/null
) > /dev/null 2>&1 && ok "a process that ignores being asked is killed after the wait" || bad "a process that ignores TERM was left running"

# ---- The upgrade script itself, with stand-ins.
# npm: `view` lists two releases; `install` makes the old release, which is a stand-in daemon: it writes
# its berth as the release it stands for and waits. OLD_KIND=no-token makes one from before --auth-token-stdin.
cat > "$BIN/npm" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  view) echo '["0.9.0","9.9.9"]' ;;
  install)
    dist="$3/node_modules/@fnndsc/chell/dist"; mkdir -p "$dist"
    version=${4##*@}
    marker='--auth-token-stdin'; [ "${OLD_KIND:-}" = no-token ] && marker='--saved-token'
    cat > "$dist/index.js" <<JS
// a stand-in for chell $version; it takes $marker
const fs = require('fs'); const path = require('path');
fs.readFileSync(0);
const dir = path.join(process.env.XDG_RUNTIME_DIR, 'calypso'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'berth-standin.json'), JSON.stringify({ pid: process.pid, versions: { chell: '$version' } }));
fs.appendFileSync(process.env.STARTED_LOG, 'old-daemon ' + process.pid + '\n');
setInterval(() => {}, 1000);
JS
    ;;
  *) exit 1 ;;
esac
EOF
# curl: CUBE issues a token (at once, or after CURL_WAIT seconds); every other address fails, so the porter
# never "comes up" and the run fails in its set-up, after the old daemon is running.
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *auth-token*) [ -n "${CURL_WAIT:-}" ] && sleep "$CURL_WAIT"; echo '{"token":"stand-in-token"}' ;;
  *) exit 7 ;;
esac
EOF
chmod +x "$BIN/npm" "$BIN/curl"
printf 'E2E_USER=stand-in\nE2E_PASSWORD=stand-in\nE2E_CUBE=http://cube.invalid/api/v1/\n' > "$WORK/e2e.env"; chmod 600 "$WORK/e2e.env"

# Runs the upgrade script as a case: its own state and runtime folders, the stand-ins first on PATH.
upgrade_run() { # name, then extra env assignments
  local name=$1; shift
  local dir="$WORK/upgrade-$name"
  mkdir -p "$dir/state"; mkdir -m 700 "$dir/runtime"
  : > "$dir/started.txt"
  env PATH="$BIN:$PATH" SMOKE_STATE="$dir/state" XDG_RUNTIME_DIR="$dir/runtime" E2E_ENV="$WORK/e2e.env" UPGRADE_PORT=41${RANDOM:0:3} STARTED_LOG="$dir/started.txt" "$@" \
    bash "$HERE/smoke-upgrade.sh" > "$dir/said.txt" 2>&1
  echo "$?" > "$dir/exit.txt"
}
# Asserts a case: its exit status, texts its ledger holds, that nothing it started is running, and that it left no folder of its own.
upgrade_expect() { # name, exit status, then texts the ledger must hold
  local name=$1 wanted=$2; shift 2
  local dir="$WORK/upgrade-$name" verdict=ok got pid
  got=$(cat "$dir/exit.txt")
  [ "$got" = "$wanted" ] || verdict="exit status $got, wanted $wanted"
  for text in "$@"; do grep -qF -- "$text" "$dir/state/ledger.txt" 2>/dev/null || verdict="the ledger lacks: $text ($(tail -1 "$dir/state/ledger.txt" 2>/dev/null))"; done
  while read -r _ pid; do kill -0 "$pid" 2>/dev/null && { verdict="a process the run started is still running (pid $pid)"; kill "$pid"; }; done < "$dir/started.txt"
  [ -z "$(ls "$dir/runtime")" ] || verdict="the run left a folder of its own behind: $(ls "$dir/runtime")"
  if [ "$verdict" = ok ]; then ok "$name"; else bad "$name: $verdict"; fi
}

(
  RUN_ROOT="$WORK/reap-spaced"; mkdir -m 700 "$RUN_ROOT"
  # A program whose name holds a space and a parenthesis: the kernel puts that name, as it is, into the line
  # the start time is read from.
  cp "$(command -v sleep)" "$WORK/bin/my (odd) sleep"
  "$WORK/bin/my (odd) sleep" 300 & spaced=$!
  sleep 0.2
  grep -q "(my (odd) sleep)" "/proc/$spaced/stat" || { echo "the stand-in's name is not what the case needs: $(cut -c1-60 "/proc/$spaced/stat")"; kill "$spaced"; exit 1; }
  daemon_note "$spaced"
  [ "$(awk '{print $2}' "$RUN_ROOT/started.pids")" = "$(awk -F') ' '{print $NF}' "/proc/$spaced/stat" | awk '{print $20}')" ] || { echo "the start noted is not the process's start"; kill "$spaced"; exit 1; }
  daemon_alive "$spaced" "$(awk '{print $2}' "$RUN_ROOT/started.pids")" || { echo "a noted process with a space in its name is not seen as alive"; kill "$spaced"; exit 1; }
  daemons_reap
  wait "$spaced" 2>/dev/null
  ! kill -0 "$spaced" 2>/dev/null
) > "$WORK/reap-spaced.txt" 2>&1 && ok "a noted process whose name holds a space and a parenthesis is noted by its true start, seen alive, and stopped" || bad "a process with a space in its name: $(cat "$WORK/reap-spaced.txt")"

echo "the upgrade script"
cp "$WORK/e2e.env" "$WORK/e2e-open.env"; chmod 644 "$WORK/e2e-open.env"
upgrade_run credentials-others-can-read E2E_ENV="$WORK/e2e-open.env"
upgrade_expect credentials-others-can-read 1 'FAIL: not started: the e2e credentials' 'has mode 644'
[ -s "$WORK/upgrade-credentials-others-can-read/started.txt" ] && bad "with open credentials something was started" || ok "with open credentials nothing was started"

mkdir -m 755 "$WORK/named-open-upgrade"
upgrade_run named-folder-others-can-reach UPGRADE_WORK="$WORK/named-open-upgrade"
upgrade_expect named-folder-others-can-reach 1 'FAIL: not started: the folder named for this run' 'has mode 755'

upgrade_run old-release-without-token-login OLD_CHELL=0.5.0 OLD_KIND=no-token
upgrade_expect old-release-without-token-login 1 'FAIL: chell 0.5.0 cannot be logged in without a saved login'
[ -s "$WORK/upgrade-old-release-without-token-login/started.txt" ] && bad "an old release that cannot take a token was started anyway" || ok "an old release that cannot take a token is not started, and no other is put in its place"

# The set-up fails after the old daemon is up (the porter never answers): nothing of the run is left.
upgrade_run setup-fails-after-the-daemon
upgrade_expect setup-fails-after-the-daemon 1 'FAIL: the porter did not come up'
grep -q '^old-daemon ' "$WORK/upgrade-setup-fails-after-the-daemon/started.txt" && ok "in that case the old daemon had been started (so there was something to stop)" || bad "the old daemon was never started: the case did not reach what it is for"

# A TERM while CUBE is being asked for a token, a command that would have succeeded: a failure by itself.
(
  dir="$WORK/upgrade-interrupted"; mkdir -p "$dir/state"; mkdir -m 700 "$dir/runtime"; : > "$dir/started.txt"
  env PATH="$BIN:$PATH" SMOKE_STATE="$dir/state" XDG_RUNTIME_DIR="$dir/runtime" E2E_ENV="$WORK/e2e.env" STARTED_LOG="$dir/started.txt" CURL_WAIT=20 \
    bash "$HERE/smoke-upgrade.sh" > "$dir/said.txt" 2>&1 &
  script=$!
  for _ in $(seq 1 100); do pgrep -f "sleep 20" > /dev/null && [ -n "$(ls "$dir/runtime")" ] && break; sleep 0.1; done
  kill -TERM "$script"
  wait "$script"; echo "$?" > "$dir/exit.txt"
)
upgrade_expect interrupted 1 'FAIL: interrupted (TERM): the run did not finish'

# Handed a folder by the nightly: the upgrade works inside it and leaves it, whatever its own verdict.
mkdir -m 700 "$WORK/handed"
upgrade_run handed-a-folder SMOKE_RUN_ROOT="$WORK/handed" OLD_CHELL=0.5.0 OLD_KIND=no-token
upgrade_expect handed-a-folder 1 'FAIL: chell 0.5.0 cannot be logged in'
[ -d "$WORK/handed/upgrade" ] && ok "a folder handed down by the nightly is still there after the upgrade returns" || bad "the upgrade removed a folder that was the nightly's"

echo "the nightly's entry"
(
  home="$WORK/nightly-home"; mkdir -p "$home/.config/mise" "$WORK/nightly-state"; mkdir -m 700 "$WORK/nightly-runtime"
  cp "$WORK/e2e.env" "$home/.config/mise/e2e.env"; chmod 644 "$home/.config/mise/e2e.env"
  env HOME="$home" SMOKE_STATE="$WORK/nightly-state" XDG_RUNTIME_DIR="$WORK/nightly-runtime" PATH="$BIN:$PATH" bash "$HERE/smoke-nightly.sh" > "$WORK/nightly-said.txt" 2>&1
  status=$?
  [ "$status" -eq 1 ] && grep -qF 'not started: the e2e credentials' "$WORK/nightly-state/ledger.txt" && grep -qF 'has mode 644' "$WORK/nightly-state/ledger.txt" && [ -z "$(ls "$WORK/nightly-runtime")" ]
) && ok "credentials others can read stop the nightly before anything is made or started" || bad "the nightly with open credentials: $(tail -2 "$WORK/nightly-said.txt" 2>/dev/null)"

echo
echo "$((cases - failed_cases)) ok, $failed_cases failed (state left in $WORK)"
[ "$failed_cases" -eq 0 ]
