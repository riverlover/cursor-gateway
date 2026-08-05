#!/usr/bin/env bash
# Build Cursor Usage HUD for macOS as a double-clickable .app (+ CLI binary)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

swift build -c release
BIN="$HERE/.build/release/CursorUsageHud"
CLI="$HERE/CursorUsageHud"
APP="$HERE/CursorUsageHud.app"

cp -f "$BIN" "$CLI"

# Assemble app bundle (required for AppKit — bare Mach-O gets SIGKILL on double-click)
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -f "$BIN" "$APP/Contents/MacOS/CursorUsageHud"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>CursorUsageHud</string>
	<key>CFBundleIdentifier</key>
	<string>com.cursor-gateway.CursorUsageHud</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Cursor Usage</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
</dict>
</plist>
PLIST

# Ad-hoc sign the app (bare linker-signed binary is not enough for GUI launch)
codesign --force --deep --sign - "$APP" 2>/dev/null || true
codesign --force --sign - "$CLI" 2>/dev/null || true

# Clear quarantine so Gatekeeper does not kill on first open
xattr -cr "$APP" 2>/dev/null || true
xattr -cr "$CLI" 2>/dev/null || true

SIZE=$(stat -f%z "$APP/Contents/MacOS/CursorUsageHud")
KB=$(python3 -c "print(f'{$SIZE/1024:.1f}')")
echo "Built CLI: $CLI"
echo "Built App: $APP  (${KB} KB)"
echo ""
echo "Double-click:  open \"$APP\""
echo "CLI once:      \"$CLI\" --once"
