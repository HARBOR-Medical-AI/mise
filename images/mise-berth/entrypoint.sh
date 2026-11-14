#!/bin/bash
# mise-berth entrypoint: names the uid the launcher gave, makes the user's home, then starts
# their session (chell's daemon, which runs calypso) on the token at /run/mise/token.
#
# The launcher sets:
#   --user <uid>:<gid>   CUBE's id for the user (the user-private group: gid = uid)
#   MISE_USER            the CUBE user name
#   MISE_CUBE_URL        the CUBE API the session signs in to (https://…/api/v1/)
#   MISE_HOST_CONTROL    the session's host-control tiers (default: shell — `!` lands here)
#   CALYPSO_BIND         where calypso listens, when porter reaches it over the berth network
#   MISE_BERTH_ANCHORS   where the session's anchors stand (/anchors), read by its `berth` verbs
#   MISE_BERTH_OUTGOING  where the berth's results are written (/outgoing), returned by `berth close`
# and writes the user's CUBE token to /run/mise/token (a tmpfs, readable by the uid alone) as
# the berth starts; the entrypoint waits for it.
#
# Given a command, the entrypoint runs it as the named user instead of the session.
set -euo pipefail

uid="$(id -u)"
gid="$(id -g)"
user="${MISE_USER:-berth}"

if [[ ! "${user}" =~ ^[A-Za-z0-9_.@+-]{1,32}$ ]]; then
  echo "mise-berth: MISE_USER '${user}' is not a CUBE user name" >&2
  exit 64
fi
if [[ "${uid}" == "0" ]]; then
  echo "mise-berth: refusing to run as root; the launcher gives the user's own uid" >&2
  exit 64
fi

home="/home/${user}"
mkdir -p "${home}"

# A uid the image has never seen has no passwd entry (or, under some runtimes, one named by
# the number), and git, ssh, Python's getpass and node's os.userInfo() all ask for one.
# nss_wrapper answers from files this user owns, so /etc stays read-only and no setuid helper
# is needed: the uid is named the user, its group the user's private group.
if [[ "$(getent passwd "${uid}" | cut -d: -f1)" != "${user}" ]]; then
  nss="$(mktemp -d /tmp/mise-nss.XXXXXX)"
  getent passwd | awk -F: -v uid="${uid}" -v user="${user}" '$3 != uid && $1 != user' >"${nss}/passwd"
  getent group | awk -F: -v gid="${gid}" -v user="${user}" '$3 != gid && $1 != user' >"${nss}/group"
  echo "${user}:x:${uid}:${gid}:${user}:${home}:/bin/bash" >>"${nss}/passwd"
  echo "${user}:x:${gid}:" >>"${nss}/group"
  export LD_PRELOAD=libnss_wrapper.so NSS_WRAPPER_PASSWD="${nss}/passwd" NSS_WRAPPER_GROUP="${nss}/group"
fi

export HOME="${home}" USER="${user}" LOGNAME="${user}" SHELL=/bin/bash
export PATH="${home}/.local/bin:${PATH}"
cd "${home}"

if [[ $# -gt 0 ]]; then
  exec "$@"
fi

# The session's runtime (its berth file, which the launcher reads back) lives beside the token, on the tmpfs.
export XDG_RUNTIME_DIR=/run/mise

# The launcher writes the token as the berth starts: it is waited for, a minute at most.
token=/run/mise/token
for _ in $(seq 1 "${MISE_TOKEN_WAIT:-600}"); do
  [[ -s "${token}" ]] && break
  sleep 0.1
done
if [[ ! -r "${token}" ]]; then
  echo "mise-berth: no token at ${token}: the launcher writes the user's CUBE token there" >&2
  exit 66
fi
if [[ -z "${MISE_CUBE_URL:-}" ]]; then
  echo "mise-berth: MISE_CUBE_URL is not set: the CUBE the session signs in to" >&2
  exit 64
fi

# The session as porter starts one (apps/porter/src/host/processHost.ts): the token on stdin,
# one line, never argv or the environment.
# Bound beyond loopback (the berth network, where porter reaches it), calypso refuses a shell
# unless told the exposure is meant: here it is, the attach token guards it, and the shell is
# this container's alone.
expose=()
if [[ -n "${CALYPSO_BIND:-}" && "${CALYPSO_BIND}" != "127.0.0.1" ]]; then
  expose=(--expose-host-control)
fi
# The token is read at each start of the session: a new login's, rewritten by the launcher,
# is the one a restarted session signs in with.
exec chell "${user}@${MISE_CUBE_URL}" --daemon --auth-token-stdin --no-logo \
  --host-control="${MISE_HOST_CONTROL:-shell}" "${expose[@]}" <"${token}"
