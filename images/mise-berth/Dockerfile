# mise-berth: one ChRIS user's working container on a spoke (docs/dev-bastion.adoc, stand-in).
#
# Every pin comes from pins.mjs (the porter a stratus deploy puts up, its Node, the calypso and
# chell that porter's release depends on, the latest Neovim with its recorded SHA-256):
#
#   docker build $(node images/mise-berth/pins.mjs | sed 's/^/--build-arg /') images/mise-berth
#
# No argument has a default: a build without the pins fails rather than guess.

ARG NODE_VERSION
FROM docker.io/library/node:${NODE_VERSION}-bookworm-slim

ARG PORTER_VERSION
ARG CALYPSO_VERSION
ARG CHELL_VERSION
ARG NVIM_VERSION
ARG NVIM_SHA256_X86_64
ARG NVIM_SHA256_ARM64
ARG TARGETARCH

RUN test -n "${PORTER_VERSION}" && test -n "${CALYPSO_VERSION}" && test -n "${CHELL_VERSION}" \
    && test -n "${NVIM_VERSION}" && test -n "${NVIM_SHA256_X86_64}" && test -n "${NVIM_SHA256_ARM64}" \
    || { echo 'mise-berth: build with the pins from images/mise-berth/pins.mjs' >&2; exit 1; }

LABEL org.opencontainers.image.title="mise-berth" \
      org.opencontainers.image.description="One ChRIS user's working container: calypso and chell, Python with the imaging stack, compilers and editors; no Docker, no cloud CLIs, no keys." \
      org.opencontainers.image.source="https://github.com/HARBOR-Medical-AI/mise" \
      org.opencontainers.image.licenses="MIT" \
      org.fnndsc.mise.porter="${PORTER_VERSION}" \
      org.fnndsc.mise.calypso="${CALYPSO_VERSION}" \
      org.fnndsc.mise.chell="${CHELL_VERSION}" \
      org.fnndsc.mise.nvim="${NVIM_VERSION}"

# The system: compilers (node-pty builds from source), Python, editors, and tini as PID 1.
# nss_wrapper gives an arbitrary uid a name without a writable /etc/passwd (entrypoint.sh).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git gcc g++ make \
       python3 python3-dev python3-pip python3-venv \
       emacs-nox vim nano less procps \
       libnss-wrapper tini \
    && rm -rf /var/lib/apt/lists/*

# The image is the user's Python: its packages go in the system site, and a user's own
# `pip install --user` lands in their persistent home. Debian's externally-managed marker
# guards apt's Python from pip; nothing here installs Python packages through apt but pip itself.
RUN rm -f /usr/lib/python3*/EXTERNALLY-MANAGED \
    && pip install --no-cache-dir uv \
    && uv pip install --system --no-cache \
       numpy scipy pandas nibabel pydicom SimpleITK chris_plugin \
    && rm -rf /root/.cache

# The latest upstream Neovim, its tarball checked against the SHA-256 GitHub records for it.
RUN case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64; sum="${NVIM_SHA256_X86_64}" ;; \
      arm64) arch=arm64; sum="${NVIM_SHA256_ARM64}" ;; \
      *) echo "mise-berth: no Neovim for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/nvim.tar.gz "https://github.com/neovim/neovim/releases/download/${NVIM_VERSION}/nvim-linux-${arch}.tar.gz" \
    && echo "${sum}  /tmp/nvim.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/nvim.tar.gz -C /opt \
    && ln -s "/opt/nvim-linux-${arch}/bin/nvim" /usr/local/bin/nvim \
    && rm /tmp/nvim.tar.gz

# calypso and chell, the versions the porter beside the berth depends on, installed as porter
# installs them: one tree, so the session's chell and the calypso it starts share one brasa
# (two global installs each carry their own, and the daemon finds no backend in its copy).
RUN mkdir -p /opt/mise \
    && cd /opt/mise \
    && printf '{"name":"mise-berth","private":true,"dependencies":{"@fnndsc/calypso":"%s","@fnndsc/chell":"%s"}}\n' "${CALYPSO_VERSION}" "${CHELL_VERSION}" > package.json \
    && npm install --no-fund --no-audit --omit=dev \
    && ln -s /opt/mise/node_modules/.bin/chell /usr/local/bin/chell \
    && ln -s /opt/mise/node_modules/.bin/calypso /usr/local/bin/calypso \
    && npm cache clean --force \
    && rm -rf /root/.cache /root/.npm

# The user's places: a home made at start under /home (sticky and open, as /tmp is, so any
# uid can make its own), the cohort read-only at /incoming, their output at /outgoing, the
# token at /run/mise/token (a tmpfs the launcher writes). The node user the base image
# carries is removed: the berth's one user is the one the launcher names.
RUN userdel -r node 2>/dev/null || true \
    && chmod 1777 /home \
    && mkdir -p /incoming /outgoing /run/mise

COPY entrypoint.sh /usr/local/bin/mise-berth
RUN chmod 0755 /usr/local/bin/mise-berth

ENV LANG=C.UTF-8 \
    EDITOR=nvim \
    PATH=/usr/local/bin:/usr/bin:/bin

USER 65534:65534
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/mise-berth"]
