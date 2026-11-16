#!/usr/bin/env bash
set -euo pipefail

# Build Local Speech for Linux (AppImage + deb)
# Requirements: Node.js (>=18), npm, and standard Linux build tools.
# electron-builder will download Electron binaries as needed.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required (>=18)." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required." >&2
  exit 1
fi

echo "==> Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "==> Building Linux packages (AppImage + deb)"
npx electron-builder --linux AppImage deb

echo ""
echo "==> Build complete. Artifacts:"
ls -lh dist/*.AppImage dist/*.deb 2>/dev/null || ls -lh dist 2>/dev/null || true
