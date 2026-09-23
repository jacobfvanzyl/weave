#!/bin/bash
set -euo pipefail
TRACKPAD_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ $# -lt 1 ]]; then
  echo 'Usage: install-ios.sh <device name or identifier> [app arguments]' >&2
  exit 2
fi
device="$1"; shift
app="$TRACKPAD_ROOT/build/Build/Products/${TRACKPAD_CONFIGURATION:-Debug}-iphoneos/TrackpadMobile.app"
xcrun devicectl device install app --device "$device" "$app"
xcrun devicectl device process launch --device "$device" --terminate-existing com.veezee.trackpad "$@"
