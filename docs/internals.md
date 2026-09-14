# DataWorker — implementation notes

Architecture, build/notarize/publish pipeline, and environment variables for this app. Built the
**bundle-desktop** way: a [Deno](https://deno.com) binary that runs a local HTTP server and opens
a native [webview](https://jsr.io/@webview/webview) window on it (the only runtime dependency —
the UI is plain HTML/CSS/JS ES modules, no bundler, no Node).

This app started from a template that supported several optional subsystems (a Java runtime, a
keychain-backed credential store, downloaded runtime components, a startup prerequisites gate).
None of those are used here, and their code has been removed; what's left is three switches in
`app.config.ts`:

| Feature    | Flag (`app.config.ts`) | What you get                                                                                |
| ---------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| macOS menu | `features.macMenu`     | A real native menu bar via FFI (`macos-menu.ts`) — also what makes ⌘A/C/V/X/Z work in the webview's text fields on macOS |
| Win menu   | `features.windowsMenu` | A native Win32 menu bar via FFI (`windows-menu.ts`) — purely additive chrome; on Windows the shortcuts work without it |
| Updates    | `features.updates`     | In-app self-update: publish under fixed names, background check, verified download, on-disk swap, **explicit-restart-only** (`server/update.ts`) |

Each is a self-contained module that is only loaded (dynamic import) and only routed when its
flag is on — turning one off costs nothing at runtime.

## Getting started

1. `deno task start` — desktop window; `deno task serve` — no window, system browser instead (the
   first `start` downloads the prebuilt `libwebview`; offline it falls back to the browser).
2. `deno task check` — type-checks every entry point.

The UI chrome: a header with the app brand, the **Update** button (updates feature), an
**activity popover** with real progress for long-running work (`ui/js/activity.js`, fed by NDJSON
progress streams — `streamResponse()` server-side, `postStream()` client-side), and a **Settings
popover** (version/platform info, language + theme toggles, the update check). Light/dark theming
rides on the vendored iOS-26 design tokens (`ui/vendor/ios26`, MIT) with
[lucide](https://lucide.dev) icons (ISC). The UI ships English and German translations
(`ui/js/i18n.js`) with a toggle in Settings.

## The architecture

```
main.ts            desktop entry: starts server.ts in a worker (the webview's native run loop
                   blocks the main thread), opens the window, installs the native menu
server.ts          the route table — core routes + the updates route behind its flag
app.config.ts      identity + feature flags + env helpers (the ONE file to configure)
macos-menu.ts      native macOS menu bar via Objective-C FFI            [macMenu]
windows-menu.ts    native Windows menu bar via user32 FFI               [windowsMenu]
server/
  http.ts          json(), NDJSON streamResponse(), static ui/ serving
  paths.ts         ROOT + per-OS data/config dirs (named after APP.id)
  version.ts       the baked-in build version (version.json)
  system.ts        native file/folder/save dialogs, reveal-in-Finder, persisted user config
  settings.ts      /api/settings snapshot (version, platform, warnings)
  repo.ts          authenticated repository downloads (env credentials)  [updates]
  update.ts        self-update check/apply/restart                      [updates]
  library.ts       the data model (libraries/fields/records) + JSON storage
  csv.ts           Bento-CSV parsing, per-column type guessing, and export
  library-routes.ts the `/api/libraries*` and `/api/import-csv` HTTP routes
ui/                index.html + app.css + js/ (ES modules, no build step)
  js/i18n.js       English/German translation dictionary + language toggle
  js/library.js    the whole app UI: sidebar, table, modals
scripts/           compile.ts (deno compile), make-app.sh, notarize.sh, publish.ts,
                   write-version.ts
```

Key mechanics inherited from bundle-desktop:

- **Server in a worker.** The webview's `run()` blocks the main thread, so the HTTP server lives in a `Worker` and posts
  its address back. Standalone (`deno task serve`) it prints the URL and opens the browser instead.
- **Same-origin guard.** The server binds 127.0.0.1 on a random port (fix it with `<PREFIX>_PORT`) and rejects
  cross-origin browser requests.
- **Progress streams.** Long-running server work emits `{pct,message}` NDJSON lines and a final `{done:true,…}`; the
  client's `postStream()` feeds the activity popover.
- **Reveal allow-list.** `/api/reveal` only opens paths your server registered in `producedOutputs` (server/system.ts) —
  the UI can offer "Reveal" for produced files.

## Feature guide

### macOS menu (`features.macMenu`)

`macos-menu.ts` builds a real menu bar through the Objective-C runtime: the Edit menu's standard nil-target selectors
are what deliver ⌘A/C/V/X/Z to the WKWebView's text fields. App items dispatch `{cmd: …}` objects into the page
(`globalThis.__nativeMenu` → `ui/js/commands.js`), so menu items and keyboard shortcuts share one command registry. A
menu failure never blocks the launch (guarded in `main.ts`).

### Windows menu (`features.windowsMenu`)

`windows-menu.ts` gives the Win32 window a classic menu bar via `user32.dll` FFI. Unlike on macOS this is **purely
additive chrome**: WebView2 (Chromium) handles Ctrl+A/C/V/X/Z in text fields by itself, and the app shortcuts already
work through the keydown table in `ui/js/main.js` — leave the flag off for a chromeless window. Menu clicks arrive as
`WM_COMMAND`, so the window is subclassed (`SetWindowLongPtrW` + `CallWindowProcW` chain) and items dispatch into the
same page command registry as the macOS menu. Same guard as the macOS menu: a failure never blocks the launch.

### Updates (`features.updates`)

```sh
deno task release        # build + notarize + publish
```

`deno task publish` uploads the **already built** app under **fixed names** to `APP.repo.updateBase` (override:
`<PREFIX>_UPDATE_URL`):

```
<app-id>-mac-<arch>.app.zip     manifest-mac-<arch>.json
<app-id>-linux-<arch>.AppImage  manifest-linux-<arch>.json
```

The app version is the ISO build timestamp `deno task compile` bakes into `version.json` (string order = release order)
plus the git commit — a republished build of the **same commit** is not offered as an update. On start the app compares
itself against the published manifest in the background; the header **Update** button appears when a newer build
exists. An update downloads, verifies the SHA-256 and swaps the install on disk — the macOS `.app`
(whole-bundle swap), a bare macOS binary, or the Linux AppImage (`$APPIMAGE`) — but **never restarts by itself**: the
button turns into **Restart** and only that click kills this instance (a detached watcher then launches the new build;
the webview's run loop can't be stopped politely, so the process signals itself). Running from source, updates are
refused — use git + `deno task build`. macOS App Translocation (running a quarantined app outside /Applications) is
detected and explained to the user.

`deno task publish` **refuses a macOS app that is not notarized + stapled** so the self-updater never installs a build
Gatekeeper distrusts (`<PREFIX>_ALLOW_UNNOTARIZED=1` overrides for test repos).

Downloads (`server/repo.ts`) authenticate through plain request first, then environment credentials
(`<PREFIX>_REPO_TOKEN` / `_AUTHORIZATION` / `_USER`+`_PASSWORD`, plus the `DENKBARES_REPO_*`/`ARTIFACTORY_*`
conventions) — not needed here since `updateBase` is a public GitHub repo's raw file URLs.

## Build & distribution

```sh
deno task build          # compile + package for this OS (ad-hoc signed on macOS)
deno task notarize       # macOS: Developer ID sign + hardened runtime + notarize + staple
deno task publish        # upload app + manifest (updates feature)
deno task check           # type-check everything
```

- `scripts/compile.ts` writes `version.json`, runs `deno compile`, and writes `dist/.appmeta` (identity for the shell
  scripts).
- `scripts/make-app.sh` packages `dist/<app-id>`:
  - **macOS** → `dist/<App Name>.app` — an AppleScript forwarder that launches the binary detached (with `--open <path>`
    for opened documents, surfaced as `openOnStart` in `/api/status`). The binary inside is named after the app — that's
    the name the Dock, app menu and ⌘Tab show; the Dock icon is set at runtime from the embedded `icon.png`.
  - **Linux** → `dist/<app-id>-<arch>.AppImage` — one portable file; the `.desktop` entry and icon apply when an
    AppImage integrator adopts it. Needs webkit2gtk at runtime for the window (falls back to the browser without it).
  - **Windows** is only partially supported: the window (WebView2), server and menu bar work, but there is no
    packaging step (the bare `dist/<app-id>.exe` is the product), no self-update target, and the native file/folder
    dialogs are no-ops (`server/system.ts` — add a PowerShell `System.Windows.Forms` branch if you need them).
- `scripts/notarize.sh` signs inside-out (the Deno binary needs the V8-JIT + `disable-library-validation` entitlements —
  `scripts/entitlements.plist` — because it loads `libwebview` via FFI), submits to Apple and staples the ticket into
  the bundle. One-time setup: a Developer ID Application certificate + a `notarytool` keychain profile (see the script
  header; override with `APP_SIGN_IDENTITY` / `APP_NOTARY_PROFILE` / `APP_NOTARY_KEYCHAIN`).

## Environment variables

All app-specific variables use `APP.envPrefix` (`DATAWORKER`):

| Variable                                                         | Effect                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `<PREFIX>_PORT`                                                  | fixed server port (default: random)                              |
| `<PREFIX>_DATA_DIR`                                              | override the library storage directory                           |
| `<PREFIX>_OPEN`                                                  | file to open on launch (set by `--open`, read via `/api/status`) |
| `<PREFIX>_UPDATE_URL`                                            | override `repo.updateBase` (mirrors, testing)                    |
| `<PREFIX>_ALLOW_UNNOTARIZED`                                     | let publish accept an un-stapled macOS app (test repos)          |
| `<PREFIX>_REPO_*`                                                | repository credentials (see `server/repo.ts`) — unused today, `updateBase` is a public repo |
| `APP_SIGN_IDENTITY`, `APP_NOTARY_PROFILE`, `APP_NOTARY_KEYCHAIN` | notarize.sh overrides                                            |

## License & attribution

- **iOS 26 design tokens** (`ui/vendor/ios26/`) — MIT (open-source reimplementation of Apple's system styles).
- **Lucide** icons (`ui/vendor/lucide.min.js`) — ISC.
