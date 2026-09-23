#!/bin/bash
set -euo pipefail
TRACKPAD_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
platform="${1:-mac}"
configuration="${TRACKPAD_CONFIGURATION:-Debug}"
shift || true
case "$platform" in
  mac) scheme=TrackpadMac; destination='platform=macOS,arch=arm64' ;;
  ios) scheme=TrackpadMobile; destination='generic/platform=iOS' ;;
  simulator) scheme=TrackpadMobile; destination='generic/platform=iOS Simulator' ;;
  *) echo 'Usage: build.sh mac|ios|simulator [additional xcodebuild arguments]' >&2; exit 2 ;;
esac
signing=()
if [[ -n "${TRACKPAD_DEVELOPMENT_TEAM:-}" ]]; then
  signing+=("DEVELOPMENT_TEAM=$TRACKPAD_DEVELOPMENT_TEAM" "CODE_SIGN_IDENTITY=Apple Development" -allowProvisioningUpdates)
else
  signing+=(CODE_SIGNING_ALLOWED=NO)
fi
xcodebuild -project "$TRACKPAD_ROOT/Trackpad.xcodeproj" -scheme "$scheme" \
  -configuration "$configuration" -destination "$destination" \
  -derivedDataPath "$TRACKPAD_ROOT/build" ONLY_ACTIVE_ARCH=YES \
  "${signing[@]}" "$@" build
