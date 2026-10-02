#!/usr/bin/env bash
# Builds "git helper.app" — a small macOS launcher for the tray app in this checkout — into
# ~/Applications (or the directory given). Clicking it starts the tray app (through its login item
# when one is set up, so it is restarted if it crashes) or, if it is already running, brings the
# dashboard window to the front. It always runs this checkout's code, so rebuilds apply directly.
# Usage: scripts/make-app.sh [install-dir]
set -euo pipefail
[ "$(uname)" = Darwin ] || { echo "macOS only" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${1:-$HOME/Applications}"
APP="$DEST_DIR/git helper.app"
DESKTOP="$ROOT/packages/desktop"
ELECTRON_APP="$(ls -d "$ROOT"/node_modules/.pnpm/electron@*/node_modules/electron/dist/Electron.app 2>/dev/null | head -1)"
[ -n "$ELECTRON_APP" ] || { echo "Electron is not installed — run pnpm install first" >&2; exit 1; }
[ -f "$DESKTOP/dist/main.js" ] || { echo "Desktop app is not built — run pnpm build first" >&2; exit 1; }
LABEL=io.github.git-helper.tray
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Icon: 1024px PNG → every size macOS wants → .icns
python3 "$DESKTOP/scripts/make-app-icon.py" "$WORK/icon.png"
mkdir "$WORK/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$WORK/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$WORK/icon.png" --out "$WORK/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/icon.iconset" -o "$WORK/applet.icns"

# The launch logic lives in a shell script inside the bundle; the applet only runs it.
cat > "$WORK/launch.sh" <<SH
#!/bin/bash
uid=\$(id -u)
if launchctl print "gui/\$uid/$LABEL" 2>/dev/null | grep -q 'state = running'; then
  # Already running: a second instance asks the first to show its window, then exits.
  "$ELECTRON_APP/Contents/MacOS/Electron" "$DESKTOP" >/dev/null 2>&1 &
elif [ -f "\$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
  launchctl bootstrap "gui/\$uid" "\$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || true
  launchctl kickstart "gui/\$uid/$LABEL"
elif pgrep -f "MacOS/Electron $DESKTOP\$" >/dev/null; then
  "$ELECTRON_APP/Contents/MacOS/Electron" "$DESKTOP" >/dev/null 2>&1 &
else
  open -n -a "$ELECTRON_APP" --args "$DESKTOP"
fi
SH
chmod +x "$WORK/launch.sh"

cat > "$WORK/launcher.applescript" <<'AS'
do shell script quoted form of (POSIX path of (path to me)) & "Contents/Resources/launch.sh"
AS

mkdir -p "$DEST_DIR"
rm -rf "$APP"
osacompile -o "$APP" "$WORK/launcher.applescript"
cp "$WORK/launch.sh" "$APP/Contents/Resources/launch.sh"
cp "$WORK/applet.icns" "$APP/Contents/Resources/applet.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleName git helper" "$APP/Contents/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleName string git helper" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string io.github.git-helper.launcher" "$APP/Contents/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier io.github.git-helper.launcher" "$APP/Contents/Info.plist"
# Run in the background: no Dock icon or menu bar for the launcher itself.
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$APP/Contents/Info.plist" 2>/dev/null || true
touch "$APP"   # refresh Finder's icon cache
echo "Built $APP"
