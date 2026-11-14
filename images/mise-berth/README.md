# mise-berth

The container one ChRIS user works in on a spoke: their own calypso and chell, so `!` lands here and never on the host that runs CUBE (docs/dev-bastion.adoc, §stand-in). A berth launcher beside porter starts one per signed-in user, with the user's CUBE uid and gid, the ChRIS data they anchor at `/anchors`, their results at `/outgoing` (both on one work volume the user owns, named to the session by `MISE_BERTH_ANCHORS` and `MISE_BERTH_OUTGOING`), and their CUBE token on a tmpfs at `/run/mise/token`.

## What it holds

- Node and the `@fnndsc/calypso` and `@fnndsc/chell` latest published on npm when the image was built, installed in one tree at `/opt/mise` as porter installs them.
- Debian trixie. Python 3.13 (Debian's, what `python3` runs) with pip and uv, and numpy, scipy, pandas, matplotlib, scikit-image, scikit-learn, nibabel, pydicom, SimpleITK, nilearn, chris_plugin, IPython and JupyterLab in the system site; a user's own `pip install --user` lands in their persistent home. `python3.12` and `python3.14` are uv's builds under `/opt/python`, bare, for a venv of the user's own.
- bash and zsh, bash-completion, tmux, manual pages.
- ripgrep, fd, fzf, jq, bat, tree, htop, file, zip and unzip, rsync, wget.
- starship, atuin, broot, lsd, zsh-autosuggestions and zsh-syntax-highlighting, for a prompt a person brings in their dotfiles; fortune, cal, finger, figlet, toilet, cpufetch and fastfetch.
- dcmtk and dcm2niix.
- gcc, g++, make, just, cmake, pkg-config, git with git-lfs, GitHub's CLI `gh`, curl, the OpenSSH client (no key and no login in the image).
- The latest upstream Neovim (its tarball checked against the SHA-256 GitHub records), emacs-nox, vim, nano.

It holds no Docker, no cloud CLI and no key. The only secret it ever sees is the user's CUBE token, which the launcher writes to `/run/mise/token` and the session reads on stdin.

## Versions

Nothing is pinned: every build takes what is latest, and the launcher runs the image by the tag `latest`. `pins.mjs` reads the versions for one build: the calypso and chell npm names as latest (`npm view <package> version`), the Node image a stratus deploy runs porter on (`CHRIS_IMAGES.node` in `packages/stratus/src/chris/profiles.ts`), and the latest Neovim release with its digests. It prints them as exact versions, one build argument a line, so an image records what it was made from. The Dockerfile has no defaults: a build without them fails.

```sh
docker build $(node images/mise-berth/pins.mjs | sed 's/^/--build-arg /') -t mise-berth images/mise-berth
```

The image records each version as a label (`org.fnndsc.mise.calypso`, `.chell`, `.nvim`). The Berth image workflow (`.github/workflows/berth-image.yml`) pushes it to `ghcr.io/<owner>/mise-berth` tagged `sha-<commit>` on every branch, and `latest` on main alone; its run summary names the digest and the versions.

## Following a release

A deployment's porter is the latest published on npm, installed at each `chris deploy`, and it carries the calypso and chell of that release. The berth image follows by the same word: `make deploy` (`scripts/deploy.sh`), once the new versions are on npm, starts the Berth image workflow on main and waits for it, so `latest` holds the calypso and chell just published before any host is upgraded. The launcher pulls `latest` before it makes a berth, and a `chris deploy` pulls it too, so a berth made after the build runs the new image; a berth already running keeps its image until it is made again.

A berth and its porter can differ for the minutes between a publish and the image build finishing: a porter installed in that window starts berths from the image of the release before. The next berth made after the build finishes is from the new one.

## Running it

The launcher runs it as the user, never as root:

```sh
docker run --user 2001:2001 \
  -e MISE_USER=ana -e MISE_CUBE_URL=https://cube.example.org/api/v1/ \
  -e MISE_BERTH_ANCHORS=/anchors -e MISE_BERTH_OUTGOING=/outgoing \
  --mount type=tmpfs,destination=/run/mise,tmpfs-mode=0700 \
  --mount type=volume,source=ana-work,destination=/anchors,volume-subpath=anchors \
  --mount type=volume,source=ana-work,destination=/outgoing,volume-subpath=outgoing \
  -v ana-home:/home/ana \
  ghcr.io/<owner>/mise-berth:latest
```

The entrypoint (`entrypoint.sh`) names the uid it was given through nss_wrapper (a passwd entry in a file the user owns, so `/etc` stays read-only and nothing is setuid), makes `/home/<user>` if no volume is mounted there, waits for the token the launcher writes as the berth starts, and starts the session as porter starts one: `chell <user>@<cube> --daemon --auth-token-stdin --no-logo --host-control=shell`, the token on stdin and read at each start of the session, so a new login's token rewritten by the launcher is the one a restarted session signs in with. The session's runtime (its berth file, which the launcher reads back for porter) is on the same tmpfs, `/run/mise`. `MISE_HOST_CONTROL` sets other tiers; `CALYPSO_BIND` sets where calypso listens, and beyond loopback the shell is exposed on purpose (`--expose-host-control`): the attach token guards it, and the shell is the container's alone. The image runs with a read-only root; its writable places are the home, `/anchors`, `/outgoing`, `/tmp` and `/run/mise`. The volume behind `/anchors` and `/outgoing` holds `anchors/` and `outgoing/`, made and given to the user's uid by the launcher before the berth starts, so a subpath mount finds them. Given a command, the entrypoint runs that as the user instead.
