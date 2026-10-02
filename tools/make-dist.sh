#!/bin/sh
# Builds dist/: the install page, its screenshot and the extension zip, side by
# side, so the folder can be opened locally or handed to someone as-is.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$root/dist" && mkdir -p "$root/dist"
sh "$root/tools/package-extension.sh" "$root" "$root/dist" >/dev/null
cp "$root/docs/screenshot.png" "$root/dist/"
cp -R "$root/docs/steps" "$root/dist/steps"
# docs/install.html is written for the Artifact host, which supplies the
# doctype and charset; opened from disk it needs its own.
{ printf '<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'; cat "$root/docs/install.html"; } > "$root/dist/install.html"
ls "$root/dist"
