#!/bin/bash
mkdir -p "$P/tmp"
install -d -p "$DEST"
docker login --password-stdin "$REGISTRY"
curl -sf -d @"$login" "${CUBE_URL}auth-token/" | node dist/index.js "$CUBE_USER@$CUBE_URL" --auth-token-stdin -c version
"$PORTER_BIN" --mint "$E2E_USER" --name "nightly" | chell --with-token
cp -p "$SRC" \
  "$DEST"
