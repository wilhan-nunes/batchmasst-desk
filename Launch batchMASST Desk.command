#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
# Finder may not include Homebrew or the standard Node installer in PATH.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1; then
  echo "Please install Node.js 22.13 or newer (including npm) from https://nodejs.org, then launch again."
else
  node launch.mjs
fi
read -r -p "Press Enter to close this window..."
