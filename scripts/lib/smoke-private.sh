# What the nightly and the upgrade smoke share: a folder of the run's own
# that nobody else can read, credentials checked before they are used, a
# login that puts no password on a command line and copies no saved login
# about, and an ending that stops what the run started.
#
# Sourced, never run: scripts/smoke-nightly.sh and scripts/smoke-upgrade.sh.
# It defines functions and sets nothing until one is called.

# Says whether a file or folder is this user's alone: owned by whoever runs
# the script, and with nothing allowed to group or others.
private_check() { # path, what it is (for the words)
  local path=$1 what=$2 owner mode
  [ -e "$path" ] || { echo "$what ($path) does not exist"; return 1; }
  owner=$(stat -c '%u' "$path") || return 1
  mode=$(stat -c '%a' "$path") || return 1
  if [ "$owner" != "$(id -u)" ]; then echo "$what ($path) is owned by user $owner, not by the user running this ($(id -u))"; return 1; fi
  case "$mode" in
    *00) ;;
    *) echo "$what ($path) has mode $mode: group or others can reach it; make it this user's alone (chmod go-rwx)"; return 1 ;;
  esac
}

# Settles the folder a run works in, and who is to remove it.
#
#   - Handed one by a parent (the nightly hands the upgrade its own): a
#     folder of the given name inside it. The parent's to remove.
#   - Named by a person debugging (an override): that folder. Made 0700 if
#     it is not there; checked to be private if it is. Never removed.
#   - Neither: a new folder from mktemp, 0700, under the user's runtime
#     folder when there is one. The run's own, removed when it ends.
#
# Sets RUN_ROOT, and RUN_ROOT_OWNED to 1 only in the last case. Call it as a
# command of its own (not in a subshell: what it sets would be lost). When
# it fails, RUN_ROOT_SAID says why.
run_root_settle() { # the parent's folder or empty, the name inside it, the override or empty, mktemp's stem
  local parent=$1 name=$2 override=$3 stem=$4
  RUN_ROOT_OWNED=0
  RUN_ROOT_SAID="the run's folder could not be made"
  if [ -n "$parent" ]; then
    RUN_ROOT_SAID=$(private_check "$parent" "the run folder handed down") || return 1
    RUN_ROOT="$parent/$name"
    mkdir -p -m 700 "$RUN_ROOT" || { RUN_ROOT_SAID="$RUN_ROOT could not be made"; return 1; }
  elif [ -n "$override" ]; then
    if [ -e "$override" ]; then
      RUN_ROOT_SAID=$(private_check "$override" "the folder named for this run") || return 1
    else
      mkdir -p -m 700 "$override" || { RUN_ROOT_SAID="$override could not be made"; return 1; }
    fi
    # A folder of this run inside it, so that what an earlier run left is not taken for this one's.
    RUN_ROOT="$override/$(date +%Y%m%d-%H%M%S)-$$"
    mkdir -m 700 "$RUN_ROOT" || { RUN_ROOT_SAID="$RUN_ROOT could not be made"; return 1; }
  else
    RUN_ROOT=$(mktemp -d "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/$stem.XXXXXXXX") || return 1
    chmod 700 "$RUN_ROOT" || return 1
    RUN_ROOT_OWNED=1
  fi
  RUN_ROOT_SAID=""
}

# Trades the e2e identity's password for a CUBE token, and prints the token.
# The password travels in a 0600 file named to the request, never on a
# command line; the file is gone when this returns. Needs E2E_USER,
# E2E_PASSWORD and E2E_CUBE in the environment.
cube_token_get() { # the private folder to work in
  local work=$1 login token status
  login=$(mktemp "$work/login.XXXXXXXX") || return 1
  node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ username: process.env.E2E_USER, password: process.env.E2E_PASSWORD }))' "$login" || { rm -f "$login"; return 1; }
  token=$(curl -sf -H 'content-type: application/json' -d @"$login" "${E2E_CUBE%/}/auth-token/" \
    | node -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => { try { process.stdout.write(String(JSON.parse(s).token ?? "")); } catch { process.exit(1); } })')
  status=$?
  rm -f "$login"
  [ "$status" -eq 0 ] && [ -n "$token" ] || return 1
  printf '%s\n' "$token"
}

# Notes a process the run started, so the ending can stop it: its pid and
# the moment it started, which together are that process and no other.
daemon_note() { # pid
  local pid=$1 started
  started=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null) || return 0
  [ -n "$started" ] && echo "$pid $started" >> "$RUN_ROOT/started.pids"
}

# Whether a noted process is still that process, and still running: the same
# pid started at the same moment, and not merely waiting to be collected.
daemon_alive() { # pid, the start it was noted with
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  # After the command's name, which may hold spaces and is in parentheses: the state, and nineteen fields on, the start.
  stat=${stat##*) }
  set -- "$1" "$2" $stat
  [ "${22}" = "$2" ] && [ "$3" != Z ]
}

# Stops every process the run noted that is still the process it noted:
# asked first, then, after a wait, killed. Returns when none is left.
daemons_reap() {
  local list="$RUN_ROOT/started.pids" pid started left
  [ -f "$list" ] || return 0
  while read -r pid started; do
    daemon_alive "$pid" "$started" && kill "$pid" 2>/dev/null
  done < "$list"
  for _ in $(seq 1 20); do
    left=0
    while read -r pid started; do
      daemon_alive "$pid" "$started" && left=1
    done < "$list"
    [ "$left" -eq 0 ] && return 0
    sleep 0.5
  done
  while read -r pid started; do
    daemon_alive "$pid" "$started" && kill -9 "$pid" 2>/dev/null
  done < "$list"
  # A killed process is gone at once; a moment for the kernel to say so.
  for _ in $(seq 1 10); do
    left=0
    while read -r pid started; do
      daemon_alive "$pid" "$started" && left=1
    done < "$list"
    [ "$left" -eq 0 ] && return 0
    sleep 0.2
  done
  return 0
}

# Removes the run's folder, if and only if this run made it by itself.
run_root_remove() {
  [ "${RUN_ROOT_OWNED:-0}" = 1 ] || return 0
  # Only a folder mktemp made here: its name is checked for what it must be before it is removed.
  case "$RUN_ROOT" in
    */mise-smoke-*.????????) rm -rf -- "$RUN_ROOT" ;;
  esac
}
