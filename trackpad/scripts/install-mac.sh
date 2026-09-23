#!/bin/bash
set -euo pipefail
TRACKPAD_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source_app="$TRACKPAD_ROOT/build/Build/Products/${TRACKPAD_CONFIGURATION:-Release}/TrackpadMac.app"
destination="$HOME/Applications/Weave Trackpad.app"
if pgrep -f '^.*/(Weave Trackpad|TrackpadMac)\.app/Contents/MacOS/TrackpadMac( |$)' >/dev/null; then
  echo 'Quit Trackpad before updating so it can release held input.' >&2
  exit 1
fi
codesign --verify --deep --strict "$source_app"
mkdir -p "$HOME/Applications" "$TRACKPAD_ROOT/.local/previous-apps"
staging="$(mktemp -d "$HOME/Applications/.weave-trackpad.XXXXXX")"
trap 'rmdir "$staging" 2>/dev/null || true' EXIT
ditto "$source_app" "$staging/Weave Trackpad.app"
codesign --verify --deep --strict "$staging/Weave Trackpad.app"
if [[ -e "$destination" ]]; then
  identifier="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$destination/Contents/Info.plist")"
  if [[ "$identifier" != 'com.veezee.trackpad.mac' ]]; then
    echo "Refusing to replace a different application at $destination" >&2
    exit 1
  fi
  backup="$(mktemp -d "$TRACKPAD_ROOT/.local/previous-apps/install.XXXXXX")"
  mv "$destination" "$backup/Weave Trackpad.app"
fi
mv "$staging/Weave Trackpad.app" "$destination"
codesign --verify --deep --strict "$destination"
open "$destination" --args "$@"
