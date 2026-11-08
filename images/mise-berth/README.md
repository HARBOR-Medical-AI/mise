# mise-berth

The container one ChRIS user works in on a spoke: their own calypso and chell, so `!` lands here and never on the host that runs CUBE (docs/dev-bastion.adoc, §stand-in). A berth launcher beside porter starts one per signed-in user, with the user's CUBE uid and gid, their cohort read-only at `/incoming`, their output at `/outgoing`, and their CUBE token on a tmpfs at `/run/mise/token`.

## What it holds

- Node and the `@fnndsc/calypso` and `@fnndsc/chell` that the porter beside it depends on, installed in one tree at `/opt/mise` as porter installs them.
- Python 3 with pip and uv, and numpy, scipy, pandas, nibabel, pydicom, SimpleITK and chris_plugin in the system site; a user's own `pip install --user` lands in their persistent home.
- gcc, g++, make, git, curl.
- The latest upstream Neovim (its tarball checked against the SHA-256 GitHub records), emacs-nox, vim, nano.

It holds no Docker, no cloud CLI and no key. The only secret it ever sees is the user's CUBE token, which the launcher writes to `/run/mise/token` and the session reads on stdin.

## Pins

Every version comes from one source: `pins.mjs` reads the porter a stratus deploy puts up (`PORTER_VERSION`) and its Node image (`CHRIS_IMAGES.node`) from `packages/stratus/src/chris/profiles.ts`, resolves the calypso and chell that porter release depends on to exact versions on the npm registry, and reads the latest Neovim release with its digests. The Dockerfile has no defaults: a build without the pins fails.

```sh
docker build $(node images/mise-berth/pins.mjs | sed 's/^/--build-arg /') -t mise-berth images/mise-berth
```

The image records each pin as a label (`org.fnndsc.mise.porter`, `.calypso`, `.chell`, `.nvim`). CI (`.github/workflows/berth-image.yml`) pushes it to `ghcr.io/<owner>/mise-berth` tagged `<porter>-<yyyymmdd>`, `sha-<commit>` and `latest`, and writes the digest consumers pin to the run's summary.

## Running it

The launcher runs it as the user, never as root:

```sh
docker run --user 2001:2001 \
  -e MISE_USER=ana -e MISE_CUBE_URL=https://cube.example.org/api/v1/ \
  --mount type=tmpfs,destination=/run/mise,tmpfs-mode=0700 \
  -v ana-incoming:/incoming:ro -v ana-outgoing:/outgoing -v ana-home:/home/ana \
  ghcr.io/<owner>/mise-berth@sha256:…
```

The entrypoint (`entrypoint.sh`) names the uid it was given through nss_wrapper (a passwd entry in a file the user owns, so `/etc` stays read-only and nothing is setuid), makes `/home/<user>` if no volume is mounted there, waits for the token the launcher writes as the berth starts, and starts the session as porter starts one: `chell <user>@<cube> --daemon --auth-token-stdin --no-logo --host-control=shell`, the token on stdin and read at each start of the session, so a new login's token rewritten by the launcher is the one a restarted session signs in with. The session's runtime (its berth file, which the launcher reads back for porter) is on the same tmpfs, `/run/mise`. `MISE_HOST_CONTROL` sets other tiers; `CALYPSO_BIND` sets where calypso listens, and beyond loopback the shell is exposed on purpose (`--expose-host-control`): the attach token guards it, and the shell is the container's alone. The image runs with a read-only root; its writable places are the home, `/outgoing`, `/tmp` and `/run/mise`. Given a command, the entrypoint runs that as the user instead.
