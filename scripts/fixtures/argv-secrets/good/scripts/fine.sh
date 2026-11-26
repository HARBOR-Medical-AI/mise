#!/bin/bash
mkdir -p "$P/tmp"
install -d -p "$DEST"
docker login --password-stdin "$REGISTRY"
curl -sf -d @"$login" "${CUBE_URL}auth-token/" | node dist/index.js "$CUBE_USER@$CUBE_URL" --auth-token-stdin -c version
"$PORTER_BIN" --mint "$E2E_USER" --name "nightly" | chell --with-token
cp -p "$SRC" \
  "$DEST"
mkdir -p "$dir" && chell --version
chell --version; mkdir -p "$dir"
mkdir -p "$HOME/.config/chell"
echo "chell & co; chell | more" ; mkdir -p "$dir"
chell "x@https://cube.example.invalid/?a=1&b=2" --version && mkdir -p "$dir"
made="$(mkdir -p "$dir" && chell --version)"
made="$(chell --version && mkdir -p "$dir")"
chell --version -c "$(mkdir -p "$dir")"
mkdir -p "$dir" 2>&1 | chell --with-token
chell --version >&2; mkdir -p "$dir"
