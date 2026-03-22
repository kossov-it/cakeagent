#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/kossov-it/cakeagent.git"
TMPDIR=$(mktemp -d)

echo "🍰 Downloading CakeAgent..."
git clone --depth 1 "$REPO" "$TMPDIR/cakeagent" 2>&1 | tail -1

cd "$TMPDIR/cakeagent"
bash setup.sh

rm -rf "$TMPDIR"
