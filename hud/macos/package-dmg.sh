#!/usr/bin/env bash
# Package CursorUsageHud.app into a distributable .dmg
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

APP="$HERE/CursorUsageHud.app"
DMG_NAME="CursorUsageHud"
VOL_NAME="Cursor Usage"
OUT_DMG="$HERE/${DMG_NAME}.dmg"
STAGING="$HERE/.dmg-staging"

if [[ ! -d "$APP" ]]; then
  echo "App not found — building first..."
  ./build.sh
fi

if [[ ! -d "$APP" ]]; then
  echo "error: $APP missing after build" >&2
  exit 1
fi

rm -rf "$STAGING" "$OUT_DMG"
mkdir -p "$STAGING"
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
xattr -cr "$STAGING/${DMG_NAME}.app" 2>/dev/null || true

hdiutil create \
  -volname "$VOL_NAME" \
  -srcfolder "$STAGING" \
  -ov \
  -format UDZO \
  -imagekey zlib-level=9 \
  "$OUT_DMG"

rm -rf "$STAGING"

SIZE=$(stat -f%z "$OUT_DMG")
KB=$(python3 -c "print(f'{$SIZE/1024:.1f}')")
echo ""
echo "Built DMG: $OUT_DMG  (${KB} KB)"
echo ""
echo "Note: ad-hoc signed only — recipients may need:"
echo "  right-click → Open, or: xattr -cr /Applications/CursorUsageHud.app"
