#!/bin/sh
# Signs, notarizes and staples the built macOS app (dist/<App Name>.app) so Gatekeeper trusts
# it on other Macs — and so the in-app self-updater installs a build that is trusted too: the
# stapled notarization ticket lives INSIDE the bundle, so it survives the publish zip ->
# download -> unzip -> whole-app swap, and Gatekeeper validates the swapped-in app offline with
# no re-notarization.
#
# `deno task build` only ad-hoc signs the app (enough to launch locally on Apple silicon). This
# step replaces that with a Developer ID signature + hardened runtime + the entitlements the
# Deno/V8/FFI runtime needs (scripts/entitlements.plist), then submits to Apple and staples.
#
#   deno task build       # produce dist/<App Name>.app first
#   deno task notarize    # this script
#   deno task publish     # upload (refuses an un-stapled app)
#   deno task release     # all three in one go
#
# One-time maintainer setup on the signing machine:
#   * A "Developer ID Application" certificate in the login keychain.
#   * Notary credentials stored as a keychain profile (uses an app-specific password from
#     appleid.apple.com, or an App Store Connect API key):
#       xcrun notarytool store-credentials notarytool-password \
#         --apple-id you@example.com --team-id <TEAMID> --password <app-specific-password>
#     (API-key form: --key AuthKey_XXXX.p8 --key-id XXXX --issuer <issuer-uuid>.)
#
# Env overrides:
#   APP_SIGN_IDENTITY    codesign identity (default: the sole "Developer ID Application")
#   APP_NOTARY_PROFILE   notarytool keychain profile (default: notarytool-password)
#   APP_NOTARY_KEYCHAIN  keychain file holding that profile (default: the login keychain)
set -eu
cd "$(dirname "$0")/.."

[ "$(uname -s)" = "Darwin" ] || { echo "notarization is macOS-only" >&2; exit 1; }

[ -f dist/.appmeta ] || { echo "dist/.appmeta is missing — run 'deno task build' first" >&2; exit 1; }
# shellcheck disable=SC1091
. dist/.appmeta   # APP_NAME, APP_ID, APP_BUNDLE_ID, APP_ENV_PREFIX

APP="dist/$APP_NAME.app"
ENTITLEMENTS="scripts/entitlements.plist"
PROFILE="${APP_NOTARY_PROFILE:-notarytool-password}"

[ -d "$APP" ] || { echo "$APP is missing — run 'deno task build' first" >&2; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "$ENTITLEMENTS is missing" >&2; exit 1; }

# --- resolve the signing identity -----------------------------------------------------------
IDENTITY="${APP_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
	IDENTITY="$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed -E 's/^[^"]*"([^"]*)".*$/\1/')"
fi
[ -n "$IDENTITY" ] || {
	echo "no 'Developer ID Application' identity in the keychain — set APP_SIGN_IDENTITY" >&2
	exit 1
}
echo "signing identity: $IDENTITY"

# --- sign inside-out --------------------------------------------------------------------------
# codesign applies --entitlements to the executable being signed, so nested Mach-O code must be
# signed BEFORE the outer bundle (--deep is deprecated and would skip entitlements on it). The
# app's own executable, Contents/MacOS/droplet (the AppleScript forwarder), is signed when the
# bundle is signed last. The only nested Mach-O today is the Deno binary in Resources; the loop
# stays general so a future nested binary is covered too. (No nested frameworks -> flat order.)
sign() {
	codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$1"
}

MAIN_EXEC="$APP/Contents/MacOS/droplet"
echo "signing nested Mach-O binaries..."
find "$APP" -type f | while IFS= read -r f; do
	[ "$f" = "$MAIN_EXEC" ] && continue
	if file -b "$f" | grep -q "Mach-O"; then
		echo "  -> $f"
		sign "$f"
	fi
done

echo "signing the app bundle..."
sign "$APP"

echo "verifying the signature..."
codesign --verify --strict --verbose=2 "$APP"

# --- notarize ---------------------------------------------------------------------------------
ZIP="dist/.notarize-$APP_ID.zip"
rm -f "$ZIP"
echo "packing the app for the notary service..."
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "submitting to Apple (profile: $PROFILE) — this can take a few minutes..."
KEYCHAIN_ARG=""
[ -n "${APP_NOTARY_KEYCHAIN:-}" ] && KEYCHAIN_ARG="--keychain ${APP_NOTARY_KEYCHAIN}"
# shellcheck disable=SC2086
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" $KEYCHAIN_ARG --wait
rm -f "$ZIP"

echo "stapling the ticket into the bundle..."
xcrun stapler staple "$APP"

echo "validating..."
xcrun stapler validate "$APP"
spctl --assess -vvv --type exec "$APP" || true

echo
echo "notarized + stapled: $APP"
echo "-> 'deno task publish' will now accept it; the ticket travels inside the bundle so the"
echo "   self-updater installs a Gatekeeper-trusted build (verified offline, no re-notarization)."
