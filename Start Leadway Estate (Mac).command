#!/bin/bash
# Double-click to start Leadway Estate on a Mac.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is not installed yet."
  echo "Download the LTS version from https://nodejs.org , install it, then double-click this file again."
  open https://nodejs.org
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
node scripts/local.mjs
