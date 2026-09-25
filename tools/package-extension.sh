#!/bin/sh
# Zip one extension directory for the Chrome Web Store.
#
# Only what Chrome reads goes in. node_modules, jsconfig.json, tests, tools and
# README screenshots are development apparatus; a store review that trips over
# them is a rejection nobody enjoys diagnosing.
#
#   sh package-extension.sh <extension-directory> [output-directory]

set -eu

dir="${1:-}"
[ -n "$dir" ] || { echo "usage: sh package-extension.sh <extension-directory> [output-directory]" >&2; exit 2; }
[ -f "$dir/manifest.json" ] || { echo "no manifest.json in $dir" >&2; exit 1; }

dir="$(cd "$dir" && pwd)"
out_dir="$(cd "${2:-$(dirname "$dir")}" && pwd)"
name="$(basename "$dir")"
# Read the version with a real JSON parser. A `sed` over the raw file is one
# `prettier --write` away from breaking: it assumes the key and value share a
# line and that nothing else in the file matches. `jq` first, then Python,
# which the icon generator already requires; the sed is only a last resort and
# is the one form that can silently produce the wrong answer.
version=""
if command -v jq >/dev/null 2>&1; then
  version="$(jq -r '.version // empty' "$dir/manifest.json")"
elif command -v python3 >/dev/null 2>&1; then
  version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version",""))' "$dir/manifest.json")"
else
  echo "warning: neither jq nor python3 found; falling back to a fragile version parse" >&2
  version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/manifest.json" | head -1)"
fi

[ -n "$version" ] || { echo "no \"version\" in $dir/manifest.json" >&2; exit 1; }
out="$out_dir/$name-$version.zip"

rm -f "$out"
cd "$dir"

# Everything except the development apparatus, rather than an allow-list: a new
# runtime directory that nobody remembered to add to a list ships broken.
zip -q -r "$out" . \
  -x '*/.*' '.*' \
  -x 'node_modules/*' \
  -x 'tests/*' 'test/*' \
  -x 'tools/*' \
  -x 'docs/*' 'dist/*' \
  -x 'package.json' 'package-lock.json' 'jsconfig.json' 'tsconfig.json' \
  -x 'README.md' 'CLAUDE.md' 'AGENTS.md' '*.zip' '*.map'

echo "$out"
unzip -l "$out" | tail -1
