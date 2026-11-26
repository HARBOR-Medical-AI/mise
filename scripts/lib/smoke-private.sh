# What the nightly and the upgrade smoke share: a folder of the run's own
# that nobody else can read, credentials checked before they are used and
# given only to the commands that need them, a login that puts no password
# on a command line and copies no saved login about, and an ending that
# stops what the run started.
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
#   - Handed one by a parent (the nightly hands the upgrade its own): a new
#     folder inside it, of this invocation alone, so that what an earlier
#     one left there is never taken for this one's. The parent's to remove.
#   - Named by a person debugging (an override): a new folder inside that
#     one, which is made 0700 if it is not there and checked to be private
#     if it is. Never removed.
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
    RUN_ROOT=$(mktemp -d "$parent/$name.XXXXXXXX") || { RUN_ROOT_SAID="a folder could not be made in $parent"; return 1; }
    chmod 700 "$RUN_ROOT" || return 1
  elif [ -n "$override" ]; then
    if [ -e "$override" ]; then
      RUN_ROOT_SAID=$(private_check "$override" "the folder named for this run") || return 1
    else
      mkdir -p -m 700 "$override" || { RUN_ROOT_SAID="$override could not be made"; return 1; }
    fi
    RUN_ROOT=$(mktemp -d "$override/run.XXXXXXXX") || { RUN_ROOT_SAID="a folder could not be made in $override"; return 1; }
    chmod 700 "$RUN_ROOT" || return 1
  else
    RUN_ROOT=$(mktemp -d "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/$stem.XXXXXXXX") || return 1
    chmod 700 "$RUN_ROOT" || return 1
    RUN_ROOT_OWNED=1
  fi
  # The folder is known from here on by where it truly is and by what it is on the disk: every later
  # cleaning checks both, so a folder or a link put in its place afterwards is never cleaned in its stead.
  RUN_ROOT=$(realpath -- "$RUN_ROOT") || { RUN_ROOT_SAID="the run's folder could not be found again"; return 1; }
  RUN_ROOT_ID=$(stat -c '%d:%i' -- "$RUN_ROOT") || { RUN_ROOT_SAID="the run's folder could not be read"; return 1; }
  RUN_ROOT_SAID=""
}

# Whether the run's folder is still the folder this run made: a real folder
# (not a link) at the place it was made, and the same one on the disk. What
# stops processes and removes things asks this first, and does nothing when
# the answer is no.
run_root_verify() {
  [ -n "${RUN_ROOT:-}" ] && [ ! -L "$RUN_ROOT" ] && [ -d "$RUN_ROOT" ] || return 1
  [ "$(realpath -- "$RUN_ROOT" 2>/dev/null)" = "$RUN_ROOT" ] || return 1
  [ -z "${RUN_ROOT_ID:-}" ] || [ "$(stat -c '%d:%i' -- "$RUN_ROOT" 2>/dev/null)" = "$RUN_ROOT_ID" ]
}

# Whether a list of entries, each ended by a NUL (an environment as the
# kernel keeps it), holds one that is exactly the entry given: compared
# whole and as it is written, so that neither a newline in the entry asked
# for nor one inside another entry's value can make a match.
entries_have() { # the file of entries, the entry
  local entry
  while IFS= read -r -d '' entry; do
    [ "$entry" = "$2" ] && return 0
  done < "$1"
  return 1
}

# Reads one name out of the credentials file, in a shell of its own, so
# that nothing in the file is left in this one. The file must supply it:
# a value of that name the caller's environment came with is cleared first.
credential_read() { # the file, the name
  # shellcheck disable=SC1090
  ( set +u; unset E2E_USER E2E_PASSWORD E2E_CUBE; . "$1" > /dev/null 2>&1 || exit 1; eval "printf '%s' \"\${$2:-}\"" )
}

# Takes up the e2e credentials: the file must be a regular file this user
# can read and nobody else can reach, it must be read without error, and it
# must name the user, the password and the CUBE. The user and the CUBE,
# which are no secret, are set and exported; the password is not put into
# this shell's environment at all. It is given only to a command run through
# password_run. When it fails, CREDENTIALS_SAID says why.
credentials_load() { # the file
  local file=$1
  CREDENTIALS_SAID=""
  # Whatever of these the caller's environment came with is dropped before anything is started: the file
  # is the one source, and a password exported by whoever ran this reaches no child.
  unset E2E_USER E2E_PASSWORD E2E_CUBE
  [ -f "$file" ] || { CREDENTIALS_SAID="the e2e credentials ($file) are not a regular file"; return 1; }
  [ -r "$file" ] || { CREDENTIALS_SAID="the e2e credentials ($file) cannot be read"; return 1; }
  CREDENTIALS_SAID=$(private_check "$file" "the e2e credentials") || return 1
  credential_read "$file" E2E_USER > /dev/null || { CREDENTIALS_SAID="the e2e credentials ($file) could not be read as a shell file"; return 1; }
  E2E_USER=$(credential_read "$file" E2E_USER)
  E2E_CUBE=$(credential_read "$file" E2E_CUBE)
  if [ -z "$E2E_USER" ] || [ -z "$E2E_CUBE" ] || [ -z "$(credential_read "$file" E2E_PASSWORD)" ]; then
    CREDENTIALS_SAID="the e2e credentials ($file) do not name E2E_USER, E2E_PASSWORD and E2E_CUBE"
    return 1
  fi
  E2E_CREDENTIALS=$file
  export E2E_USER E2E_CUBE
  CREDENTIALS_SAID=""
}

# Runs one command with the e2e password in its environment, and only it:
# the file is read in a shell that becomes that command. The file is held
# again to what it was held to at the start (this user's alone), and must
# still name the user and the CUBE that were taken up then: a file that has
# since been opened to others, no longer reads, no longer names the
# password, or now names another account or another CUBE runs nothing, so a
# password is never sent to an address it was not checked against.
password_run() { # the command and its arguments
  # shellcheck disable=SC1090
  (
    set +u
    want_user=$E2E_USER; want_cube=$E2E_CUBE
    [ -f "$E2E_CREDENTIALS" ] && private_check "$E2E_CREDENTIALS" "the e2e credentials" > /dev/null || exit 1
    unset E2E_USER E2E_PASSWORD E2E_CUBE
    set -a; . "$E2E_CREDENTIALS" > /dev/null 2>&1 || exit 1; set +a
    [ -n "${E2E_PASSWORD:-}" ] && [ "${E2E_USER:-}" = "$want_user" ] && [ "${E2E_CUBE:-}" = "$want_cube" ] || exit 1
    exec "$@"
  )
}

# Writes the login payload (the user and the password, as JSON) to a file.
# The one place the password is read; the file is this user's alone (0600),
# whatever the umask of whoever calls.
login_payload_write() { # the file to write
  password_run node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ username: process.env.E2E_USER, password: process.env.E2E_PASSWORD }), { mode: 0o600 }); fs.chmodSync(process.argv[1], 0o600);' "$1"
}

# Trades the e2e identity's password for a CUBE token, and prints the token.
# The password travels in a 0600 file named to the request, never on a
# command line; the file is gone when this returns.
cube_token_get() { # the private folder to work in
  local work=$1 login token status
  login=$(mktemp "$work/login.XXXXXXXX") || return 1
  login_payload_write "$login" || { rm -f "$login"; return 1; }
  token=$(curl -sf -H 'content-type: application/json' -d @"$login" "${E2E_CUBE%/}/auth-token/" \
    | node -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => { try { process.stdout.write(String(JSON.parse(s).token ?? "")); } catch { process.exit(1); } })')
  status=$?
  rm -f "$login"
  [ "$status" -eq 0 ] && [ -n "$token" ] || return 1
  printf '%s\n' "$token"
}

# Removes what a run may have left that is a secret, each by the path the
# run itself put it at, in the run's folder and in the folder of a step
# inside it:
#
#   - a token, a login payload, a cookie jar;
#   - the stores its daemons and porter kept credentials in: each daemon's
#     config folder (where a login saves its token, and a door login its
#     door's) and the porter's credential store;
#   - each daemon's berth and its attach note, which carry the token its
#     sessions are let in by, and which a daemon that had to be killed did
#     not remove itself.
#
# Done at every ending, after what the run started is stopped, so that a
# folder kept for a person to look at holds none. Logs and the list of
# what was started are left. Nothing is removed through a link: a path
# that reaches its place by way of one is left and counted as a failure.
# Returns 1 if anything could not be looked at, could not be removed, or
# is still there.
secrets_remove() { # the run's folder
  local dir=$1 root place path parent left=0
  [ -n "$dir" ] || return 0
  # The folder itself, as it is named: never a link, and never somewhere other than where its name says.
  # (The name is not resolved first: a link put in the folder's place would then pass for the folder.)
  if [ -L "$dir" ]; then return 1; fi
  [ -d "$dir" ] || return 0
  [ "$(realpath -- "$dir" 2>/dev/null)" = "$dir" ] || return 1
  # The run's own folder is, besides, the very folder the run made.
  if [ "$dir" = "${RUN_ROOT:-}" ]; then run_root_verify || return 1; fi
  for root in "$dir" "$dir"/*; do
    [ -d "$root" ] || continue
    # A step's folder is a folder the run made, never a link to one.
    if [ -L "$root" ]; then left=1; continue; fi
    # Every folder that is looked into must be one this user can look into, or what is in it goes unseen.
    for place in "$root" "$root"/state "$root"/state/* "$root"/run "$root"/run/calypso "$root"/state/*/run "$root"/state/*/run/calypso "$root"/tmp "$root"/state/*/tmp; do
      [ -d "$place" ] || continue
      [ -r "$place" ] && [ -x "$place" ] || left=1
    done
    for path in "$root"/token "$root"/login.* "$root"/cj \
                "$root"/config "$root"/state/creds "$root"/state/*/config \
                "$root"/run/calypso/berth-*.json "$root"/state/*/run/calypso/berth-*.json \
                "$root"/tmp/calypso-*.attach "$root"/state/*/tmp/calypso-*.attach; do
      [ -e "$path" ] || [ -L "$path" ] || continue
      parent=$(dirname -- "$path")
      # Reached by way of a link: not the run's own place, and not removed through it.
      if [ "$(realpath -- "$parent" 2>/dev/null)" != "$parent" ]; then left=1; continue; fi
      rm -rf -- "$path" 2>/dev/null || left=1
      if [ -e "$path" ] || [ -L "$path" ]; then left=1; fi
    done
  done
  [ "$left" -eq 0 ]
}

# Reads a process's state and the moment it started, as "<state> <start>".
# The one place /proc/<pid>/stat is read: the command's name stands second
# in it, in parentheses, and may itself hold spaces and parentheses, so the
# fields are counted from after the last closing one.
process_stat_read() { # pid
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat=${stat##*) }
  # What is left begins with the state (the third field of the whole); the start is the twenty-second.
  # shellcheck disable=SC2086
  set -- $stat
  [ -n "${20:-}" ] || return 1
  echo "$1 ${20}"
}

# Notes a process the run started, so the ending can stop it: its pid and
# the moment it started, which together are that process and no other. For
# a process this script launched itself, by the pid the shell gave it.
daemon_note() { # pid
  local pid=$1 read
  read=$(process_stat_read "$pid") || return 0
  echo "$pid ${read#* }" >> "$RUN_ROOT/started.pids"
}

# Notes a process the run did not launch by its own hand (a daemon the
# porter started), and only on proof that it is the run's: its environment
# names a folder inside this run's own. What is noted is the pid with the
# start it had when the proof was read, and only if it has that start still
# afterwards: the pair that was verified, and no other. Without the proof
# it is not noted, and is never stopped.
daemon_note_owned() { # pid, the environment entry that proves it (NAME=value)
  local pid=$1 proof=$2 before after
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  before=$(process_stat_read "$pid") || return 1
  # One whole entry of the environment, as the kernel keeps them (each ended by a NUL), compared literally.
  { entries_have "/proc/$pid/environ" "$proof"; } 2>/dev/null || return 1
  after=$(process_stat_read "$pid") || return 1
  [ "${before#* }" = "${after#* }" ] || return 1
  grep -qxF -- "$pid ${before#* }" "$RUN_ROOT/started.pids" 2>/dev/null || echo "$pid ${before#* }" >> "$RUN_ROOT/started.pids"
}

# Notes every process of this user's whose environment carries the proof:
# what a porter of the run started, whether or not it has yet written the
# berth it would be found by. Call it once whatever starts such processes
# has been stopped, so that none appears after the look.
daemons_note_proven() { # the environment entry that proves a process is the run's
  local proof=$1 entry
  for entry in /proc/[0-9]*; do
    [ -O "$entry" ] || continue
    daemon_note_owned "${entry#/proc/}" "$proof"
  done
  return 0
}

# Whether a noted process is still that process, and still running: the same
# pid started at the same moment, and not merely waiting to be collected.
daemon_alive() { # pid, the start it was noted with
  local read
  read=$(process_stat_read "$1") || return 1
  [ "${read#* }" = "$2" ] && [ "${read%% *}" != Z ]
}

# Stops the noted processes named, or every noted one: each that is still
# the process it was noted as (the pid and the start, never the pid alone)
# is asked to stop, waited for, and killed if it does not. Returns 0 when
# none of them is left running; otherwise 1, and DAEMONS_LEFT names those
# that are.
daemons_stop() { # pids to stop; none for every noted process
  local list="$RUN_ROOT/started.pids" pid started left wanted=" $* "
  DAEMONS_LEFT=""
  # The list is read only from the folder this run made: one put in its place could name any process.
  run_root_verify || { DAEMONS_LEFT="unknown: the run's folder is no longer the one this run made"; return 1; }
  [ -f "$list" ] || return 0
  # Whether a noted pid is among those asked for.
  wanted_has() { [ "$wanted" = "  " ] || case "$wanted" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
  while read -r pid started; do
    wanted_has "$pid" && daemon_alive "$pid" "$started" && kill "$pid" 2>/dev/null
  done < "$list"
  for _ in $(seq 1 20); do
    left=0
    while read -r pid started; do
      wanted_has "$pid" && daemon_alive "$pid" "$started" && left=1
    done < "$list"
    [ "$left" -eq 0 ] && return 0
    sleep 0.5
  done
  while read -r pid started; do
    wanted_has "$pid" && daemon_alive "$pid" "$started" && kill -9 "$pid" 2>/dev/null
  done < "$list"
  # A killed process is gone at once; a moment for the kernel to say so.
  for _ in $(seq 1 10); do
    left=0
    while read -r pid started; do
      wanted_has "$pid" && daemon_alive "$pid" "$started" && left=1
    done < "$list"
    [ "$left" -eq 0 ] && return 0
    sleep 0.2
  done
  while read -r pid started; do
    wanted_has "$pid" && daemon_alive "$pid" "$started" && DAEMONS_LEFT="$DAEMONS_LEFT $pid"
  done < "$list"
  DAEMONS_LEFT=${DAEMONS_LEFT# }
  [ -z "$DAEMONS_LEFT" ]
}

# Stops every process the run noted. See daemons_stop.
daemons_reap() {
  daemons_stop
}

# Says that the run's folder must be kept, and why: by a step working in a
# folder inside it that could not stop what it started. The folder's owner
# reads it in run_root_remove.
run_root_keep() { # the folder to keep (the parent's), the reason
  echo "$2" >> "$1/kept"
}

# Removes the run's folder, if and only if this run made it by itself and
# nothing in it asked to be kept. Returns 1 when a step asked for that
# (nothing is removed) or when the folder could not be removed:
# RUN_ROOT_KEPT then says which.
run_root_remove() {
  RUN_ROOT_KEPT=""
  [ "${RUN_ROOT_OWNED:-0}" = 1 ] || return 0
  run_root_verify || { RUN_ROOT_KEPT="it is no longer the folder this run made"; return 1; }
  if [ -s "$RUN_ROOT/kept" ]; then RUN_ROOT_KEPT=$(tr '\n' ';' < "$RUN_ROOT/kept"); return 1; fi
  # Only a folder mktemp made here: its name is checked for what it must be before it is removed.
  case "$RUN_ROOT" in
    */mise-smoke-*.????????) rm -rf -- "$RUN_ROOT" 2>/dev/null; [ ! -e "$RUN_ROOT" ] || { RUN_ROOT_KEPT="it could not be removed"; return 1; } ;;
  esac
}

# The newest published release strictly before a version: read from a JSON
# list of versions on standard input, by their numbers (a prerelease is
# never chosen). Prints it, or nothing when there is none.
version_before() { # the version to come before
  VERSION_AT="$1" node -e '
    const parse = (text) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text)); return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]; };
    const order = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const at = parse(process.env.VERSION_AT);
    let listed = [];
    try { listed = [JSON.parse(require("fs").readFileSync(0, "utf8"))].flat(); } catch { process.exit(1); }
    if (at === null) process.exit(1);
    const before = listed.map((text) => [text, parse(text)]).filter(([, v]) => v !== null && order(v, at) < 0).sort((a, b) => order(a[1], b[1]));
    process.stdout.write(before.length === 0 ? "" : before[before.length - 1][0]);'
}
