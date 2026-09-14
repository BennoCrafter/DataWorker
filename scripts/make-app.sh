#!/bin/sh
# Packages the compiled binary (dist/<app-id>) as a desktop app for the system this script
# runs on — run it via `deno task build`, which compiles the binary (and writes dist/.appmeta,
# the identity this script reads) first:
#
#   macOS → dist/<App Name>.app — an AppleScript forwarder bundle. Custom icon, ad-hoc signed,
#           registered with Launch Services. To register file associations, fill in the
#           commented UTI/document-type block below.
#   Linux → dist/<app-id>-<arch>.AppImage — one portable file, no install step. The embedded
#           .desktop entry and icon provide the menu entry when an integrator (e.g.
#           AppImageLauncher) adopts it; without one it simply runs. The first run downloads
#           appimagetool (cached in dist/).
set -eu
cd "$(dirname "$0")/.."

[ -f dist/.appmeta ] || { echo "dist/.appmeta is missing — run 'deno task build'" >&2; exit 1; }
# shellcheck disable=SC1091
. dist/.appmeta   # APP_NAME, APP_ID, APP_BUNDLE_ID, APP_ENV_PREFIX

[ -x "dist/$APP_ID" ] || { echo "dist/$APP_ID is missing — run 'deno task build'" >&2; exit 1; }

# --- macOS app bundle -----------------------------------------------------------------------

build_macos_app() {
	APP="dist/$APP_NAME.app"

	echo "building $APP..."
	rm -rf "$APP"

	# the app is an AppleScript forwarder: `on open` (a double-clicked / "Open With" document)
	# launches the binary with --open <path>; `on run` (the app itself) launches it plain
	TMP="$(mktemp -t app-forwarder).applescript"
	cat > "$TMP" <<OSA
on run
	launchApp("")
end run

on open theFiles
	repeat with f in theFiles
		launchApp(POSIX path of f)
	end repeat
end open

on launchApp(p)
	set res to (POSIX path of (path to me)) & "Contents/Resources/$APP_NAME"
	if p is "" then
		do shell script quoted form of res & " > /dev/null 2>&1 &"
	else
		do shell script quoted form of res & " --open " & quoted form of p & " > /dev/null 2>&1 &"
	end if
end launchApp
OSA
	osacompile -o "$APP" "$TMP"
	rm -f "$TMP"

	# place the compiled binary where the applet looks for it — named after the app: the applet
	# launches it detached, so THIS is the process macOS shows in the Dock, the app menu and
	# Cmd+Tab, and an unbundled process is named after its executable
	cp "dist/$APP_ID" "$APP/Contents/Resources/$APP_NAME"
	chmod +x "$APP/Contents/Resources/$APP_NAME"

	# app icon: build a .icns from icon.png (1024x1024) and use it in place of the applet default
	if [ -f icon.png ]; then
		echo "building the app icon..."
		ICONSET="$(mktemp -d)/icon.iconset"
		mkdir -p "$ICONSET"
		for spec in "16:16x16" "32:16x16@2x" "32:32x32" "64:32x32@2x" \
			"128:128x128" "256:128x128@2x" "256:256x256" "512:256x256@2x" "512:512x512" "1024:512x512@2x"; do
			px="${spec%%:*}"
			name="${spec##*:}"
			sips -z "$px" "$px" icon.png --out "$ICONSET/icon_$name.png" >/dev/null
		done
		iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/$APP_ID.icns"
		rm -rf "$(dirname "$ICONSET")"
		# osacompile ships the droplet icon as an asset catalog referenced by CFBundleIconName;
		# that wins over CFBundleIconFile, so drop it and fall back to our loose .icns
		rm -f "$APP/Contents/Resources/Assets.car" "$APP/Contents/Resources/droplet.icns"
		/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
	fi

	PLIST="$APP/Contents/Info.plist"

	pb "Set :CFBundleName $APP_NAME"
	[ -f "$APP/Contents/Resources/$APP_ID.icns" ] && { pb "Set :CFBundleIconFile $APP_ID" 2>/dev/null || pb "Add :CFBundleIconFile string $APP_ID"; }
	pb "Add :CFBundleIdentifier string $APP_BUNDLE_ID" 2>/dev/null || pb "Set :CFBundleIdentifier $APP_BUNDLE_ID"
	pb "Add :CFBundleDisplayName string $APP_NAME" 2>/dev/null || true
	pb "Add :LSMinimumSystemVersion string 11.0" 2>/dev/null || true

	# --- OPTIONAL: file associations — exported UTIs + document types ------------------------
	# Fill in and uncomment to register the app as a document handler (LSHandlerRank: Owner =
	# default opener, Alternate = listed under "Open With"). Example for a ".thing" file:
	#
	# pb "Add :UTExportedTypeDeclarations array" 2>/dev/null || true
	# pb "Add :UTExportedTypeDeclarations:0 dict"
	# pb "Add :UTExportedTypeDeclarations:0:UTTypeIdentifier string $APP_BUNDLE_ID.thing"
	# pb "Add :UTExportedTypeDeclarations:0:UTTypeDescription string My Thing"
	# pb "Add :UTExportedTypeDeclarations:0:UTTypeConformsTo array"
	# pb "Add :UTExportedTypeDeclarations:0:UTTypeConformsTo:0 string public.data"
	# pb "Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification dict"
	# pb "Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension array"
	# pb "Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:0 string thing"
	#
	# pb "Add :CFBundleDocumentTypes array" 2>/dev/null || true
	# pb "Add :CFBundleDocumentTypes:0 dict"
	# pb "Add :CFBundleDocumentTypes:0:CFBundleTypeName string My Thing"
	# pb "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Editor"
	# pb "Add :CFBundleDocumentTypes:0:LSHandlerRank string Owner"
	# pb "Add :CFBundleDocumentTypes:0:LSItemContentTypes array"
	# pb "Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string $APP_BUNDLE_ID.thing"
	# ------------------------------------------------------------------------------------------

	# re-sign (ad-hoc): the plist/resource edits above invalidated osacompile's signature, and an
	# invalid signature makes macOS distrust the bundle and fall back to a generic icon. This is
	# enough to launch on the build machine; `deno task notarize` replaces it with a Developer ID
	# signature + notarized ticket for distribution (required before `deno task publish`).
	codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

	# register with Launch Services so Finder learns the app (and any associations above)
	LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
	[ -x "$LSREG" ] && "$LSREG" -f "$APP" || true

	echo "built $APP"
}

pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST" >/dev/null; }

# --- Linux AppImage -------------------------------------------------------------------------

build_appimage() {
	ARCH="$(uname -m)"
	OUT="dist/$APP_ID-$ARCH.AppImage"
	TOOL="dist/.appimagetool"
	APPDIR="dist/AppDir"

	echo "building the AppDir..."
	rm -rf "$APPDIR"
	mkdir -p "$APPDIR/usr/bin"
	cp "dist/$APP_ID" "$APPDIR/usr/bin/$APP_ID"
	chmod +x "$APPDIR/usr/bin/$APP_ID"
	cp icon.png "$APPDIR/$APP_ID.png"
	cp icon.png "$APPDIR/.DirIcon"

	cat > "$APPDIR/AppRun" <<APPRUN
#!/bin/sh
exec "\$(dirname "\$0")/usr/bin/$APP_ID" "\$@"
APPRUN
	chmod +x "$APPDIR/AppRun"

	# add MimeType=…; for file associations (pair with the macOS block above)
	cat > "$APPDIR/$APP_ID.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$APP_NAME
Exec=$APP_ID %f
Icon=$APP_ID
StartupWMClass=$APP_ID
Terminal=false
Categories=Utility;
DESKTOP

	if [ ! -x "$TOOL" ]; then
		echo "downloading appimagetool..."
		curl -fsSL -o "$TOOL" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$ARCH.AppImage"
		chmod +x "$TOOL"
	fi

	echo "packing $OUT..."
	rm -f "$OUT"
	# --appimage-extract-and-run: works without FUSE (e.g. in containers/CI)
	ARCH="$ARCH" "$TOOL" --appimage-extract-and-run "$APPDIR" "$OUT" >/dev/null
	rm -rf "$APPDIR"

	echo "built $OUT"
	echo "-> menu entry (and any file associations) arrive when an AppImage integrator adopts it."
}

# --- dispatch on the current system ----------------------------------------------------------

case "$(uname -s)" in
	Darwin) build_macos_app ;;
	Linux) build_appimage ;;
	*)
		echo "no app packaging for $(uname -s) — the compiled app is dist/$APP_ID" >&2
		exit 1
		;;
esac
