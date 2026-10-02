#!/usr/bin/env bash
# Builds "git helper.app" into ~/Applications (or the directory given): a real app bundle — a
# copy-on-write clone of this checkout's Electron, renamed and re-iconed, whose app folder is a
# link back to packages/desktop. What you click and what runs are the same app, so Keep in Dock,
# Cmd+Q and clicking it again behave like any Mac app, and `pnpm build` applies without rebuilding
# the bundle. Re-run after moving the checkout or upgrading Electron.
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
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
plist() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$APP/Contents/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$APP/Contents/Info.plist"; }

# Icon: 1024px PNG → every size macOS wants → .icns
python3 "$DESKTOP/scripts/make-app-icon.py" "$WORK/icon.png"
mkdir "$WORK/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$WORK/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$WORK/icon.png" --out "$WORK/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/icon.iconset" -o "$WORK/icon.icns"

mkdir -p "$DEST_DIR"
rm -rf "$APP"
cp -cR "$ELECTRON_APP" "$APP" 2>/dev/null || cp -R "$ELECTRON_APP" "$APP"   # -c: APFS clone, no extra space
# Electron runs Resources/app when there is one; point it at this checkout.
rm -f "$APP/Contents/Resources/default_app.asar"
ln -s "$DESKTOP" "$APP/Contents/Resources/app"
cp "$WORK/icon.icns" "$APP/Contents/Resources/electron.icns"
plist CFBundleName "git helper"
plist CFBundleDisplayName "git helper"
plist CFBundleIdentifier io.github.git-helper
# Editing the bundle breaks Electron's signature; re-sign it ad hoc so macOS will launch it.
codesign --force --deep --sign - "$APP" 2>/dev/null
touch "$APP"

# Point an existing "Start at login" item at the new bundle.
if [ -f "$HOME/Library/LaunchAgents/io.github.git-helper.tray.plist" ]; then
  ( cd "$DESKTOP" && node --input-type=module -e "
    import { enableLoginItem, loginShellPath } from './dist/login.js';
    enableLoginItem({ electron: process.argv[1], path: loginShellPath() });" "$APP/Contents/MacOS/Electron" )
  echo "Updated the login item to start $APP"
fi
echo "Built $APP"
