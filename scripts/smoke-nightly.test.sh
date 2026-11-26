#!/usr/bin/env bash
# The nightly's accounting, driven with stand-ins: a red stage or step is a
# line in the ledger AND a non-zero exit.
#
# Sources scripts/smoke-nightly.sh without running it (SMOKE_NIGHTLY_SOURCED=1)
# and calls its own functions: run_record with the status and log a stand-in
# runner left, door_step with a stand-in porter and a stand-in `node` first on
# PATH, upgrade_step with a stand-in upgrade script, nightly_finish for the
# verdict. Each case runs in a subshell with a state folder of its own.
#
# Every folder it makes is new, under ${TMPDIR:-/tmp}, and is left there: this
# script deletes nothing.
#
# Run: bash scripts/smoke-nightly.test.sh   (exits 1 when any case fails)
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/smoke-nightly-test.XXXXXX")
BIN="$WORK/bin"
mkdir -p "$BIN"
failed_cases=0
cases=0

# A stand-in for `node packages/chell/dist/index.js …`: records the door
# command it was asked for, and fails the ones named in DOOR_FAILS.
cat > "$BIN/node" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"auth login"*) step=login; cat > /dev/null ;;
  *"auth status"*) step=status ;;
  *"auth logout"*) step=logout ;;
  *" -e -c "*) step=stops-at-first-error ;;
  *" -c pwd"*) step=pwd ;;
  *) step=other ;;
esac
echo "$step" >> "$DOOR_CALLS"
if [ "$step" = stops-at-first-error ]; then
  case " ${DOOR_FAILS:-} " in
    *" e-goes-on "*) echo "cd: /nowhere: No such file or directory" >&2; echo "/home/stand-in"; exit 0 ;;
    *" e-crashes "*) echo "cd: /nowhere: No such file or directory" >&2; echo "Segmentation fault" >&2; exit 139 ;;
    *) echo "cd: /nowhere: No such file or directory" >&2; exit 1 ;;
  esac
fi
case " ${DOOR_FAILS:-} " in *" $step "*) echo "stand-in: $step failed"; exit 1 ;; esac
exit 0
EOF

# A stand-in porter: it has door tokens, and mints one unless told to fail.
# Told to be an old one, it refuses the word as an old porter does; told its
# probe fails, it fails as one that has tokens and cannot list them.
cat > "$BIN/porter" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = --tokens ]; then
  case " ${DOOR_FAILS:-} " in
    *" porter-is-old "*) echo "[!] unknown word '--tokens'" >&2; exit 2 ;;
    *" probe-fails "*) echo "[!] the token store could not be read" >&2; exit 1 ;;
  esac
  exit 0
fi
echo mint >> "$DOOR_CALLS"
case " ${DOOR_FAILS:-} " in *" mint "*) echo "stand-in: mint failed"; exit 1 ;; esac
printf 'minted for %s\nthe-token\n' "$2"
EOF

# Stand-in upgrade scripts: one that passes, one that fails.
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/upgrade-ok"
printf '#!/usr/bin/env bash\nexit 1\n' > "$BIN/upgrade-red"

# Stand-in stage runners: what each prints is the stage's log, and its exit status the runner's.
cat > "$BIN/runner-green" <<'EOF'
#!/usr/bin/env bash
printf '  ok    a scenario\n\n3 ok, 0 failed\n'
EOF
cat > "$BIN/runner-red" <<'EOF'
#!/usr/bin/env bash
printf '  ok    a scenario\n  FAIL  the other scenario\n\n1 ok, 1 failed: the other scenario\n'
exit 1
EOF
cat > "$BIN/runner-crashed" <<'EOF'
#!/usr/bin/env bash
echo 'TypeError: something was undefined'
exit 0
EOF
cat > "$BIN/runner-timed-out" <<'EOF'
#!/usr/bin/env bash
printf '  ok    a scenario\n'
exit 124
EOF
chmod +x "$BIN"/*
: > "$WORK/porter.env"

# Runs one case in a subshell: a fresh state folder, the nightly sourced, the
# case's own lines, then the verdict. Prints "<exit status of nightly_finish>"
# on the last line of its output file, after the ledger.
case_run() { # name, the case's body (a function name)
  local name=$1 body=$2
  local state="$WORK/$name"
  mkdir -p "$state/private/config"
  (
    export SMOKE_STATE="$state" SMOKE_PRIVATE="$state/private" SMOKE_NIGHTLY_SOURCED=1
    export PORTER_BIN="$BIN/porter" PORTER_ENV="$WORK/porter.env" DOOR_CALLS="$state/door-calls.txt"
    export E2E_USER=stand-in PATH="$BIN:$PATH"
    : > "$DOOR_CALLS"
    # shellcheck source=scripts/smoke-nightly.sh
    . "$HERE/smoke-nightly.sh"
    "$body" > "$state/said.txt" 2>&1
    nightly_finish
    echo "$?" > "$state/exit.txt"
  )
}

# Asserts one case's exit status and that its ledger holds, or lacks, a text.
expect() { # name, exit status wanted, then pairs: has|lacks <text>
  local name=$1 wanted=$2; shift 2
  local state="$WORK/$name" verdict=ok got
  cases=$((cases + 1))
  got=$(cat "$state/exit.txt" 2>/dev/null || echo none)
  [ "$got" = "$wanted" ] || verdict="exit status $got, wanted $wanted"
  while [ "$#" -ge 2 ]; do
    if [ "$1" = has ] && ! grep -qF -- "$2" "$state/ledger.txt" 2>/dev/null; then verdict="the ledger lacks: $2"; fi
    if [ "$1" = lacks ] && grep -qF -- "$2" "$state/ledger.txt" 2>/dev/null; then verdict="the ledger holds: $2"; fi
    shift 2
  done
  if [ "$verdict" = ok ]; then echo "  ok    $name"; else echo "  FAIL  $name: $verdict"; failed_cases=$((failed_cases + 1)); fi
}

# Asserts the door commands a case asked for, in order.
expect_calls() { # name, the calls wanted, space-separated
  local name=$1 wanted=$2 got
  cases=$((cases + 1))
  got=$(tr '\n' ' ' < "$WORK/$name/door-calls.txt" | sed 's/ $//')
  if [ "$got" = "$wanted" ]; then echo "  ok    $name: door commands"; else echo "  FAIL  $name: door commands were '$got', wanted '$wanted'"; failed_cases=$((failed_cases + 1)); fi
}

# One stage through a stand-in runner, as run() does it: the runner's output is the log, its status is kept.
stage() { # stage name, runner
  "$BIN/$2" > "$log.$1" 2>&1
  local status=$?
  run_record "$1" "$status" "$log.$1"
}

stages_green() { stage desk runner-green; stage tablet runner-green; }
stage_red() { stage desk runner-green; stage tablet runner-red; }
stage_crashed() { stage desk runner-crashed; }
stage_timed_out() { stage desk runner-timed-out; }
door_green() { door_step; }
door_login_fails() { DOOR_FAILS=login door_step; }
door_logout_fails() { DOOR_FAILS=logout door_step; }
door_mint_fails() { DOOR_FAILS=mint door_step; }
door_e_goes_on() { DOOR_FAILS=e-goes-on door_step; }
door_e_crashes() { DOOR_FAILS=e-crashes door_step; }
door_probe_fails() { DOOR_FAILS=probe-fails door_step; }
door_porter_is_old() { DOOR_FAILS=porter-is-old door_step; }
upgrade_green() { SMOKE_UPGRADE="$BIN/upgrade-ok" upgrade_step; }
upgrade_red() { SMOKE_UPGRADE="$BIN/upgrade-red" upgrade_step; }
all_green() { stage desk runner-green; door_step; SMOKE_UPGRADE="$BIN/upgrade-ok" upgrade_step; }
one_red_among_green() { stage desk runner-green; DOOR_FAILS=status door_step; SMOKE_UPGRADE="$BIN/upgrade-ok" upgrade_step; }

for body in stages_green stage_red stage_crashed stage_timed_out door_green door_login_fails door_logout_fails door_mint_fails door_e_goes_on door_e_crashes door_probe_fails door_porter_is_old upgrade_green upgrade_red all_green one_red_among_green; do
  case_run "$body" "$body"
done

echo "stages"
expect stages_green 0 has 'desk  3 ok, 0 failed' has 'tablet  3 ok, 0 failed'
expect stage_red 1 has 'tablet  1 ok, 1 failed: the other scenario' has '  FAIL  the other scenario' has 'desk  3 ok, 0 failed'
expect stage_crashed 1 has 'desk  no summary (crashed?)'
expect stage_timed_out 1 has 'desk  no summary (crashed?)'
echo "the door"
expect door_green 0 has 'door  ok (mint, login by token, status, chell -c, -e, logout)'
expect_calls door_green 'mint login status pwd stops-at-first-error logout'
expect door_login_fails 1 has 'door  FAIL' lacks 'door  ok'
# A login that fails is not hidden by the logout that follows it and works.
expect_calls door_login_fails 'mint login status pwd stops-at-first-error logout'
expect door_logout_fails 1 has 'door  FAIL' lacks 'door  ok'
expect door_mint_fails 1 has 'door  FAIL' lacks 'door  ok'
# The batch that should stop at its first error: going on past it is a red, and so is a crash, even one that refused the cd first.
expect door_e_goes_on 1 has 'door  FAIL' lacks 'door  ok'
expect door_e_crashes 1 has 'door  FAIL' lacks 'door  ok'
# A porter that has tokens and cannot list them is a red; one from before door tokens is the one skip.
expect door_probe_fails 1 has 'door  FAIL (the porter could not list its door tokens, exit 1' lacks 'skipped'
expect_calls door_probe_fails ''
expect door_porter_is_old 0 has 'door  skipped: the installed porter has no door tokens yet' lacks 'door  FAIL'
echo "the upgrade"
expect upgrade_green 0
expect upgrade_red 1
echo "the whole run"
expect all_green 0 has 'door  ok' has 'desk  3 ok, 0 failed'
expect one_red_among_green 1 has 'door  FAIL' has 'desk  3 ok, 0 failed'

echo
echo "$((cases - failed_cases)) ok, $failed_cases failed (state left in $WORK)"
[ "$failed_cases" -eq 0 ]
