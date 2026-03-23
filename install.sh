#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/kossov-it/cakeagent.git"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "🍰 Downloading CakeAgent..."
git clone --depth 1 "$REPO" "$WORK_DIR/cakeagent" 2>&1 | tail -1

cd "$WORK_DIR/cakeagent"
bash setup.sh </dev/tty
