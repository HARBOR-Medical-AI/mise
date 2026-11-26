#!/bin/bash
# A comment may say: chell x -p "$PW"
chell x@y -p "$PW" -c version
curl --token "$T" https://example.invalid/
node dist/index.js "$USER@$URL" \
  --no-logo \
  -p "$CUBE_PASSWORD" \
  -c version
tool --password="$PW"
tool --token	"$T"
chell x@y -p		"$PW" -c version
calypso --daemon --token \
    "$ATTACH"
node dist/index.js x@y -p \
	"$PW"
mkdir -p "$D"; tool --password "$PW"
mkdir -p "$dir" && chell x@y -p "$PW" -c version
chell --version && mkdir -p "$dir"
chell "x@https://cube.example.invalid/api/v1/?a=1&b=2" -p "$PW" -c version
chell 'x@host;port|other' -p "$PW"
chell x@host\&more -p "$PW"
chell "$(hostname | tr a-z A-Z)" -p "$PW"
chell $(hostname | tr a-z A-Z) -p "$PW"
(cd "$dir" && chell x@y -p "$PW")
made="$(mkdir -p "$dir" && chell x@y -p "$PW")"
chell x@y 2>&1 -p "$PW"
chell x@y -c "$(mkdir -p "$dir")" -p "$PW"
out=`chell x@y -p "$PW"`
chell x@y &>/dev/null -p "$PW"
