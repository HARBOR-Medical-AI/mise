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
( run_root_settle "$WORK/parent" upgrade "" mise-smoke-upgrade && first=$RUN_ROOT && [ "$(dirname "$RUN_ROOT")" = "$WORK/parent" ] && [ "$RUN_ROOT_OWNED" = 0 ] && [ "$(stat -c %a "$RUN_ROOT")" = 700 ] && run_root_remove && [ -d "$RUN_ROOT" ] \
  && touch "$first/left-by-the-first" && run_root_settle "$WORK/parent" upgrade "" mise-smoke-upgrade && [ "$RUN_ROOT" != "$first" ] && [ -z "$(ls -A "$RUN_ROOT")" ] && [ -e "$first/left-by-the-first" ] ) \
  && ok "handed a folder by a parent: a new folder inside it each time, empty, and not this run's to remove; what an earlier one left is untouched" || bad "handed a folder by a parent"
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

# A folder whose name holds a space, each way it can be come by.
mkdir -m 700 "$WORK/run time"; mkdir -m 700 "$WORK/a parent"
( XDG_RUNTIME_DIR="$WORK/run time"; run_root_settle "" "" "" mise-smoke-nightly && [ -d "$RUN_ROOT" ] && [ "$(dirname "$RUN_ROOT")" = "$WORK/run time" ] && run_root_remove && [ ! -e "$RUN_ROOT" ] ) \
  && ok "a runtime folder with a space in its name: the run's folder is made in it and removed from it" || bad "a runtime folder with a space in its name"
( run_root_settle "$WORK/a parent" upgrade "" mise-smoke-upgrade && [ "$(dirname "$RUN_ROOT")" = "$WORK/a parent" ] && run_root_settle "" "" "$WORK/a named one" mise-smoke-nightly && [ "$(dirname "$RUN_ROOT")" = "$WORK/a named one" ] ) \
  && ok "a parent's folder and a named folder with spaces in their names" || bad "a parent's or a named folder with a space in its name"
profile=$(SMOKE_CHROME_FLAGS="--no-sandbox" SMOKE_PROFILE_DIR="$WORK/run time/browser/desk" node -e "import('$HERE/../apps/argus/tests/smoke/driver.mjs').then((m) => console.log(JSON.stringify(m.chromeFlags_read(process.env))))")
[ "$profile" = "[\"--no-sandbox\",\"--user-data-dir=$WORK/run time/browser/desk\"]" ] && ok "the browser's profile folder reaches chromium as one argument, a space in it and all" || bad "the profile folder was split: $profile"

echo "the credentials"
printf 'E2E_USER=stand-in\nE2E_PASSWORD=the-password\nE2E_CUBE=http://cube.invalid/api/v1/\n' > "$WORK/creds.env"; chmod 600 "$WORK/creds.env"
( credentials_load "$WORK/creds.env" && [ "$E2E_USER" = stand-in ] && [ "$E2E_CUBE" = http://cube.invalid/api/v1/ ] && [ -z "${E2E_PASSWORD:-}" ] && ! env | grep -q the-password \
  && [ "$(password_run sh -c 'printf %s "$E2E_PASSWORD"')" = the-password ] && ! env | grep -q the-password \
  && login_payload_write "$WORK/payload.json" && grep -q '"password":"the-password"' "$WORK/payload.json" && [ "$(stat -c %a "$WORK/payload.json")" = 600 ] ) \
  && ok "the user and the CUBE are taken up; the password is in no environment but that of the one command given it" || bad "the credentials were not taken up as they should be"
mkdir "$WORK/creds-dir"; ln -s "$WORK/creds.env" "$WORK/creds-link.env"
printf 'E2E_USER=stand-in\nE2E_CUBE=http://cube.invalid/\n' > "$WORK/creds-short.env"; chmod 600 "$WORK/creds-short.env"
printf 'E2E_USER=stand-in\nif then fi (\n' > "$WORK/creds-broken.env"; chmod 600 "$WORK/creds-broken.env"
cp "$WORK/creds.env" "$WORK/creds-open.env"; chmod 644 "$WORK/creds-open.env"
for case in "creds-dir:not a regular file" "no-such.env:not a regular file" "creds-short.env:do not name E2E_USER, E2E_PASSWORD and E2E_CUBE" "creds-broken.env:could not be read as a shell file" "creds-open.env:has mode 644"; do
  file=${case%%:*}; words=${case#*:}
  ( credentials_load "$WORK/$file"; status=$?; [ "$status" -ne 0 ] && case "$CREDENTIALS_SAID" in *"$words"*) exit 0 ;; *) echo "$CREDENTIALS_SAID"; exit 1 ;; esac ) > "$WORK/creds-said.txt" 2>&1 \
    && ok "credentials refused: $words" || bad "credentials ($file) were not refused with \"$words\": $(cat "$WORK/creds-said.txt")"
done
mkdir -m 700 "$WORK/secrets"; touch "$WORK/secrets/token" "$WORK/secrets/login.json" "$WORK/secrets/login.Ab12Cd34" "$WORK/secrets/cj" "$WORK/secrets/porter.log"
( secrets_remove "$WORK/secrets"; [ "$(ls "$WORK/secrets")" = porter.log ] ) && ok "a token, a login payload and a cookie jar are removed from a folder that is kept; its logs stay" || bad "secrets were left, or more than secrets removed: $(ls "$WORK/secrets" | tr '\n' ' ')"

echo "which release an upgrade starts from"
for case in '["5.0.0","5.1.0","5.2.0"]|5.2.0|5.1.0' '["5.0.0","5.2.0"]|5.1.0|5.0.0' '["5.0.0","5.1.0","9.9.9"]|5.1.5|5.1.0' '["5.2.0","6.0.0"]|5.2.0|' '["5.10.0","5.9.0","5.2.0"]|5.11.0|5.10.0' '["5.1.0","5.2.0-beta.1"]|5.2.0|5.1.0' '[]|5.2.0|'; do
  IFS='|' read -r listed new wanted <<< "$case"
  got=$(printf '%s' "$listed" | version_before "$new")
  [ "$got" = "$wanted" ] && ok "before $new among $listed: ${wanted:-none}" || bad "before $new among $listed: got \"$got\", wanted \"$wanted\""
done

echo "what the run started"
(
  RUN_ROOT="$WORK/reap"; mkdir -m 700 "$RUN_ROOT"
  sleep 300 & noted=$!
  sleep 300 & bystander=$!
  daemon_note "$noted"
  # The bystander's pid with a start time that is not its own: a pid the run once noted, since given to another process.
  echo "$bystander 1" >> "$RUN_ROOT/started.pids"
  daemons_reap || { echo "the reaping said something was left: $DAEMONS_LEFT"; exit 1; }
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
    env | grep -q '^E2E_PASSWORD=' && echo "npm had the password" >> "$STARTED_LOG.leaks"
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
if (process.env.E2E_PASSWORD !== undefined) fs.appendFileSync(process.env.STARTED_LOG + '.leaks', 'the old daemon had the password\n');
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

(
  RUN_ROOT="$WORK/stop-one"; mkdir -m 700 "$RUN_ROOT"
  sleep 300 & one=$!
  sleep 300 & other=$!
  daemon_note "$one"; daemon_note "$other"
  daemons_stop "$one" || exit 1
  wait "$one" 2>/dev/null
  kill -0 "$one" 2>/dev/null && { echo "the one asked for is still running"; exit 1; }
  kill -0 "$other" 2>/dev/null || { echo "the other was stopped too"; exit 1; }
  daemons_reap && wait "$other" 2>/dev/null; ! kill -0 "$other" 2>/dev/null
) > "$WORK/stop-one.txt" 2>&1 && ok "one noted process is stopped by name and the other left, until all are" || bad "stopping one: $(cat "$WORK/stop-one.txt")"
(
  RUN_ROOT="$WORK/owned"; mkdir -m 700 "$RUN_ROOT"
  MARK="$WORK/owned/run" sh -c 'exec sleep 300' & ours=$!
  sleep 300 & stranger=$!
  sleep 0.2
  daemon_note_owned "$ours" "MARK=$WORK/owned/run" || { echo "a process whose environment names the run's folder was not taken as the run's"; kill "$ours" "$stranger"; exit 1; }
  daemon_note_owned "$stranger" "MARK=$WORK/owned/run" && { echo "a process with no such environment was taken as the run's"; kill "$ours" "$stranger"; exit 1; }
  daemon_note_owned "" "MARK=x" && { echo "no pid at all was noted"; exit 1; }
  [ "$(wc -l < "$RUN_ROOT/started.pids")" = 1 ] || { echo "the list holds $(wc -l < "$RUN_ROOT/started.pids") entries"; kill "$ours" "$stranger"; exit 1; }
  daemons_reap; wait "$ours" 2>/dev/null
  kill -0 "$stranger" 2>/dev/null || { echo "the stranger was stopped"; exit 1; }
  kill "$stranger"
) > "$WORK/owned.txt" 2>&1 && ok "a process the run did not launch is noted only on proof that it is the run's, and one without it is never stopped" || bad "ownership: $(cat "$WORK/owned.txt")"
(
  RUN_ROOT="$WORK/unstoppable"; mkdir -m 700 "$RUN_ROOT"
  # A process this user may not signal, noted as it truly is: the reaping cannot stop it, and must say so.
  echo "1 $(process_stat_read 1 | cut -d' ' -f2)" > "$RUN_ROOT/started.pids"
  daemons_reap; status=$?
  [ "$status" -eq 1 ] && [ "$DAEMONS_LEFT" = 1 ]
) > /dev/null 2>&1 && ok "a noted process that cannot be stopped is reported, by its pid, and the reaping fails" || bad "a process that could not be stopped was not reported"

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
[ "$(ls "$WORK/handed" | wc -l)" = 1 ] && ok "a folder handed down by the nightly is still there after the upgrade returns, with this run's folder in it" || bad "the upgrade removed a folder that was the nightly's"
# A second run handed the same folder works in a folder of its own, and the first one's is as it was left.
first=$(ls "$WORK/handed"); touch "$WORK/handed/$first/left-by-the-first"
upgrade_run handed-a-folder-again SMOKE_RUN_ROOT="$WORK/handed" OLD_CHELL=0.5.0 OLD_KIND=no-token
[ "$(ls "$WORK/handed" | wc -l)" = 2 ] && [ -e "$WORK/handed/$first/left-by-the-first" ] && ok "a second run against the same handed folder makes its own inside it and leaves the first's alone" || bad "a second run reused or removed the first's folder: $(ls "$WORK/handed" | tr '\n' ' ')"

# The release chosen when none is named: the newest published below the checkout's, never the one above it.
grep -q "old chell 0.9.0 (published)" "$WORK/upgrade-setup-fails-after-the-daemon/state/"*-upgrade.log && ok "with 0.9.0 and 9.9.9 published the upgrade starts from 0.9.0, not from the one above the checkout" || bad "the release chosen: $(grep 'old chell' "$WORK/upgrade-setup-fails-after-the-daemon/state/"*-upgrade.log)"
# The password reached neither npm nor the old daemon, in any of the runs above.
cat "$WORK"/upgrade-*/started.txt.leaks 2>/dev/null | sort -u > "$WORK/leaks.txt"
[ ! -s "$WORK/leaks.txt" ] && ok "the password reached neither npm nor the old daemon" || bad "the password leaked: $(tr '\n' ';' < "$WORK/leaks.txt")"

# A folder named by a person is kept, and after a failure it holds no token, login payload or cookie jar.
mkdir -m 700 "$WORK/named kept"
upgrade_run named-and-kept UPGRADE_WORK="$WORK/named kept"
kept=$(find "$WORK/named kept" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$kept" ] && [ -f "$kept/porter.log" ] && [ -z "$(find "$kept" -maxdepth 1 \( -name token -o -name 'login.*' -o -name cj \))" ] && ok "a named folder (with a space in its name) is kept after a failure, its logs there and no secret in it" || bad "the named folder after a failure: $(ls "$kept" 2>/dev/null | tr '\n' ' ')"
# A runtime folder with a space in its name: the run still ends clean.
(
  dir="$WORK/upgrade-spaced"; mkdir -p "$dir/state"; mkdir -m 700 "$dir/run time"; : > "$dir/started.txt"
  env PATH="$BIN:$PATH" SMOKE_STATE="$dir/state" XDG_RUNTIME_DIR="$dir/run time" E2E_ENV="$WORK/e2e.env" UPGRADE_PORT=41${RANDOM:0:3} STARTED_LOG="$dir/started.txt" bash "$HERE/smoke-upgrade.sh" > "$dir/said.txt" 2>&1
  status=$?
  [ "$status" -eq 1 ] && grep -qF 'FAIL: the porter did not come up' "$dir/state/ledger.txt" && grep -q '^old-daemon ' "$dir/started.txt" && [ -z "$(ls "$dir/run time")" ] && while read -r _ pid; do ! kill -0 "$pid" 2>/dev/null || exit 1; done < "$dir/started.txt"
) && ok "under a runtime folder with a space in its name the run gets as far, fails the same way, and leaves nothing" || bad "a runtime folder with a space in its name: $(tail -1 "$WORK/upgrade-spaced/state/ledger.txt" 2>/dev/null)"

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
