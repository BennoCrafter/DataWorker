# desktop-app-template — implementation notes

This was the README until it was trimmed to a short, user-facing one. Kept because it is the only write-up of the
architecture, each optional feature in depth, the build/notarize/publish pipeline, the environment variables and how to
remove a feature's code entirely.

A template for lightweight desktop apps built the **bundle-desktop** way: a [Deno](https://deno.com) binary that runs a
local HTTP server and opens a native [webview](https://jsr.io/@webview/webview) window on it (the only runtime
dependency — the UI is plain HTML/CSS/JS ES modules, no bundler, no Node). Everything else is an **optional feature**
you switch on or off in one file:

| Feature    | Flag (`app.config.ts`)   | What you get                                                                                                                                 |
| ---------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS menu | `features.macMenu`       | A real native menu bar via FFI (`macos-menu.ts`) — also what makes ⌘A/C/V/X/Z work in the webview's text fields on macOS                     |
| Win menu   | `features.windowsMenu`   | A native Win32 menu bar via FFI (`windows-menu.ts`) — purely additive chrome; on Windows the shortcuts work without it                       |
| Java       | `features.java`          | A Java runtime for Java-backed work (`server/java.ts`): **fat** builds embed a thinned JRE, **slim** builds resolve a system JDK             |
| Keychain   | `features.keychain`      | Secrets from the denkbares keychain (`~/.des-kch`) via a small Java helper, with the unlock password from the macOS login Keychain/env       |
| Components | `features.components`    | Big variable assets **downloaded on first launch** instead of shipped, updated only on explicit request (`server/components.ts`)             |
| Updates    | `features.updates`       | In-app self-update: publish under fixed names, background check, verified download, on-disk swap, **explicit-restart-only** (`update.ts`)    |
| Prereqs    | `features.prerequisites` | A **startup gate**: registered prerequisite checks (installed tools etc.) must all pass before the UI lets the user in (`server/prereqs.ts`) |

Every feature is a self-contained module that is only loaded (dynamic import) and only routed when its flag is on — a
disabled feature costs nothing at runtime and is excluded from the compiled binary's embedded assets
(`scripts/compile.ts` assembles the `deno compile` command from the flags).

## Getting started

1. **Edit `app.config.ts`** — the one file that defines your app:
   - `id`, `name`, `macBundleId`, `envPrefix` — identity: window title, packaging, data/cache dirs, artifact names,
     `<PREFIX>_*` env vars.
   - `features` — turn off what you don't need (see the matrix below).
   - `repo.updateBase` — where updates/components are published (components/updates features).
2. **Replace `icon.png`** with your 1024×1024 app icon.
3. `deno task start` — desktop window; `deno task serve` — no window, system browser instead (the first `start`
   downloads the prebuilt `libwebview`; offline it falls back to the browser).
4. Build your app:
   - UI: `ui/index.html` (replace the placeholder panel), `ui/js/main.js` (boot + wiring), `ui/js/commands.js` (commands
     shared by shortcuts and the macOS menu).
   - Server: add routes in `server.ts` (marked spots), feature logic in new `server/` modules.
   - macOS menu: add your menus in `macos-menu.ts` (marked spot).

The UI chrome that comes with the template: a header with the app brand, a status pill (Java runtime / component setup /
ready), the **Update** button (updates feature), an **activity popover** with real progress for long-running work
(`ui/js/activity.js`, fed by NDJSON progress streams — `streamResponse()` server-side, `postStream()` client-side), and
a **Settings popover** whose sections adapt to the enabled features. Light/dark theming rides on the vendored iOS-26
design tokens (`ui/vendor/ios26`, MIT) with [lucide](https://lucide.dev) icons (ISC).

## The architecture

```
main.ts            desktop entry: starts server.ts in a worker (the webview's native run loop
                   blocks the main thread), opens the window, installs the native menu
server.ts          the route table — core routes + feature routes behind their flags
app.config.ts      identity + feature flags + env helpers (the ONE file to configure)
macos-menu.ts      native macOS menu bar via Objective-C FFI            [macMenu]
windows-menu.ts    native Windows menu bar via user32 FFI               [windowsMenu]
server/
  http.ts          json(), NDJSON streamResponse(), static ui/ serving
  paths.ts         ROOT + per-OS cache/data/config dirs (named after APP.id)
  version.ts       the baked-in build version (version.json)
  system.ts        native file/folder/save dialogs, reveal-in-Finder, persisted user config
  settings.ts      /api/settings snapshot (adapts to the enabled features)
  java.ts          Java runtime resolution, embedded-JRE extraction      [java]
  keychain.ts      keychain snapshot/overview, macOS password store      [keychain]
  repo.ts          authenticated repository access (env + keychain)     [components/updates]
  components.ts    downloaded-component registry + factories            [components]
  update.ts        self-update check/apply/restart                      [updates]
  prereqs.ts       startup prerequisite checks (the gate)              [prerequisites]
ui/                index.html + app.css + js/ (ES modules, no build step)
helper/            KeychainTool.java (precompiled at build time)        [keychain]
jars/              keychain-cli.jar                                     [keychain]
prep/              jre.zip + jre-info.json (built by build:jre)         [java, fat builds]
scripts/           compile.ts (feature-aware deno compile), make-app.sh, notarize.sh,
                   publish.ts, build-jre.ts, compile-helpers.ts, write-version.ts
```

Key mechanics inherited from bundle-desktop:

- **Server in a worker.** The webview's `run()` blocks the main thread, so the HTTP server lives in a `Worker` and posts
  its address back. Standalone (`deno task serve`) it prints the URL and opens the browser instead.
- **Same-origin guard.** The server binds 127.0.0.1 on a random port (fix it with `<PREFIX>_PORT`) and rejects
  cross-origin browser requests.
- **Progress streams.** Long-running server work emits `{pct,message}` NDJSON lines and a final `{done:true,…}`; the
  client's `postStream()` feeds the activity popover.
- **Embedded-asset materialization.** Files baked into the compiled binary live in a virtual filesystem only the Deno
  process can read — `server/java.ts` copies them to temp files once per run so external processes (java) can use them.
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
same page command registry as the macOS menu; the accelerator texts on the items are display-only (real accelerator
tables would need the message loop, which libwebview owns — the in-page shortcut table is the actual implementation).
Same guard as the macOS menu: a failure never blocks the launch. Note this module is the one part of the template not
exercised by the original bundle-desktop app (which shipped mac/linux only) — smoke-test it once on a real Windows
machine before shipping.

### Java (`features.java`)

Two build variants:

- `deno task build` — **slim**: no runtime shipped; a system **JDK ≥ `APP.java.required`** is resolved via `JAVA_HOME` →
  (macOS) `/usr/libexec/java_home` → `PATH`, each candidate's version validated (a stale `JAVA_HOME` never shadows an
  installed matching JDK — also covers Finder launches, which have no shell environment). Problems surface in the status
  pill and Settings; everything except the Java-backed features keeps working.
- `deno task build:fat` — **fat**: embeds a **thinned JRE** (`prep/jre.zip`, ~44 MB zipped) built by
  `deno task build:jre` with jlink from the fixed Temurin release in `APP.java.jdkRelease`: the full `java.se` API
  surface (so independently-updating downloaded components can rely on any SE module) plus the usual providers and
  `jdk.compiler`, locales trimmed to `APP.java.jreLocales`, no Graal JIT/JFR/agents. Platform-specific — build on the
  platform you ship for. Extracted once into the user cache on first use.

Building blocks for your app: `javaBinary()`, `runJar()`, `runJarStreaming()`, `materialize()`.

### Keychain (`features.keychain`, requires java)

Reads credentials from the **denkbares keychain** (`~/.des-kch`, or `DES_KEYCHAIN`) through `helper/KeychainTool.java`
on `jars/keychain-cli.jar` — entry keys are Java regexes matched against URLs; the same file the CLI and build tooling
use. The app never writes the keychain; it only manages the **unlock password**: from `DES_KEYCHAIN_PW` (the only source
on Linux), or — macOS — stored once in the **login Keychain** via the `security` CLI, so a Finder-launched app can
unlock it. The login-Keychain entry (service `com.denkbares.keychain`) is ONE fixed entry shared by all denkbares
apps — set the password in one app and every other app finds it; passwords stored under the older per-app service
names are adopted into the shared entry on first read. No secret ever touches a plaintext file. The Settings popover
sets/changes/clears the password and reports whether credentials for the repository are present.

`deno task compile` precompiles the helper (`helper/classes/`) so a keychain call costs bare JVM startup instead of a
per-call javac compile; source runs fall back to the java source launcher.

### Components (`features.components`)

Register downloads in `server/components.ts` → `COMPONENTS` using the factories:

- `mavenLatestReleaseJar({name, label, base, classifier?, file})` — resolves the newest release from
  `maven-metadata.xml` and downloads the versioned jar to a fixed local name.
- `checksumVersionedZip({name, label, url})` — a fixed-URL archive whose "version" is its checksum header; downloaded
  and extracted to `<name>/<stamp>`, older extractions pruned.

First launch: `ui/js/main.js` checks `componentsReady`, guides the user to Settings when no credentials are reachable,
then downloads with progress. Components are **never updated automatically** — the Update button / Settings check covers
them. Resolve installed artifacts with `installedFile(name)` / `installedDir(name)`.

Downloads authenticate through `server/repo.ts`: plain request first, then env credentials (`<PREFIX>_REPO_TOKEN` /
`_AUTHORIZATION` / `_USER`+`_PASSWORD`, plus the `DENKBARES_REPO_*`/`ARTIFACTORY_*` conventions), then the keychain
(when on).

### Updates (`features.updates`)

```sh
deno task release        # slim: build + notarize + publish
deno task release:fat    # fat:  build:fat + notarize + publish
```

`deno task publish` uploads the **already built** app under **fixed names** to `APP.repo.updateBase` (override:
`<PREFIX>_UPDATE_URL`):

```
<app-id>-mac-<arch>[-fat].app.zip     manifest-mac-<arch>[-fat].json
<app-id>-linux-<arch>[-fat].AppImage  manifest-linux-<arch>[-fat].json
```

(Fat artifacts are suffixed `-fat`, slim are unsuffixed; each installed app polls the manifest of its own variant. Note:
bundle-desktop suffixes the _slim_ variant for historic reasons — this template starts clean the other way around.)

The app version is the ISO build timestamp `deno task compile` bakes into `version.json` (string order = release order)
plus the git commit — a republished build of the **same commit** is not offered as an update. On start the app compares
itself and the components against the published manifests in the background; the header **Update** button appears when
anything is newer. An app update downloads, verifies the SHA-256 and swaps the install on disk — the macOS `.app`
(whole-bundle swap), a bare macOS binary, or the Linux AppImage (`$APPIMAGE`) — but **never restarts by itself**: the
button turns into **Restart** and only that click kills this instance (a detached watcher then launches the new build;
the webview's run loop can't be stopped politely, so the process signals itself). Running from source, updates are
refused — use git + `deno task build`. macOS App Translocation (running a quarantined app outside /Applications) is
detected and explained to the user.

`deno task publish` **refuses a macOS app that is not notarized + stapled** so the self-updater never installs a build
Gatekeeper distrusts (`<PREFIX>_ALLOW_UNNOTARIZED=1` overrides for test repos). The variant is read from
`dist/.variant`, so an artifact can never land under the other variant's names.

### Prerequisites (`features.prerequisites`)

A startup gate: register your app's requirements in `server/prereqs.ts` (the `PREREQUISITES` list —
`binaryPrerequisite()` covers "is tool X installed" and `portPrerequisite()` "is port N still free", anything else is a
custom `check()`). Before the UI boots, `ui/js/prereqs.js` fetches `/api/prereqs`; if anything is missing it shows a
blocking screen listing every requirement with an install hint per failed item, re-checks on the **Check Again** button
and on a gentle auto-poll, and only lets the user into the app once everything passes. If all requirements are already
met the gate never appears. The check runs server-side, so a Finder-launched app's bare `PATH` is handled (the usual
Homebrew dirs are probed).

Beyond the prose `hint`, an item can carry **`commands`** (rendered as code blocks with a copy button), a **`link`**
(opened in the user's real browser through `/api/open-url`, which only accepts URLs the app registered in
`externalLinks` — a webview must never navigate away from the app), and a **`fix`** plus **`apply()`**: an input field
whose value is POSTed to `/api/prereqs/fix` and installed server-side, so a pasted token or keychain password can be set
before Settings is even reachable. `<PREFIX>_SKIP_PREREQS=1` skips the gate entirely; `<PREFIX>_FAIL_PREREQS=1` forces
every item to fail so the screen can be reviewed on a fully set-up machine.

## Build & distribution

```sh
deno task build          # slim: compile + package for this OS (ad-hoc signed on macOS)
deno task build:fat      # fat:  build the JRE (cached) + compile + package
deno task notarize       # macOS: Developer ID sign + hardened runtime + notarize + staple
deno task publish        # upload app + manifest (updates feature)
deno task check          # type-check everything
```

- `scripts/compile.ts` writes `version.json`, precompiles the keychain helper (keychain feature), assembles
  `deno compile` with only the enabled features' assets, and writes `dist/.variant` + `dist/.appmeta` (identity for the
  shell scripts).
- `scripts/make-app.sh` packages `dist/<app-id>`:
  - **macOS** → `dist/<App Name>.app` — an AppleScript forwarder that launches the binary detached (with `--open <path>`
    for opened documents, surfaced as `openOnStart` in `/api/status`). The binary inside is named after the app — that's
    the name the Dock, app menu and ⌘Tab show; the Dock icon is set at runtime from the embedded `icon.png`. File
    associations: fill in the commented UTI/document-type block.
  - **Linux** → `dist/<app-id>-<arch>.AppImage` — one portable file; the `.desktop` entry and icon apply when an
    AppImage integrator adopts it. Needs webkit2gtk at runtime for the window (falls back to the browser without it).
  - **Windows** is only partially supported (inherited from bundle-desktop, which shipped mac/linux): the window
    (WebView2), server, menu bar and component downloads work, but there is no packaging step (the bare
    `dist/<app-id>.exe` is the product), no self-update target, and the native file/folder dialogs are no-ops
    (`server/system.ts` — add a PowerShell `System.Windows.Forms` branch if you need them).
- `scripts/notarize.sh` signs inside-out (the Deno binary needs the V8-JIT + `disable-library-validation` entitlements —
  `scripts/entitlements.plist` — because it loads `libwebview` via FFI), submits to Apple and staples the ticket into
  the bundle. One-time setup: a Developer ID Application certificate + a `notarytool` keychain profile (see the script
  header; override with `APP_SIGN_IDENTITY` / `APP_NOTARY_PROFILE` / `APP_NOTARY_KEYCHAIN`).

## Turning a feature off — or removing it entirely

Flipping the flag in `app.config.ts` is always enough: the module is never imported, its routes 404, the UI hides its
sections, and the compiled binary drops its assets. To also delete the code:

| Feature     | Delete                                                                 | Also remove the references in                                                                                  |
| ----------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| macMenu     | `macos-menu.ts`                                                        | `main.ts` (the guarded dynamic import)                                                                         |
| windowsMenu | `windows-menu.ts`                                                      | `main.ts` (the guarded dynamic import)                                                                         |
| java        | `server/java.ts`, `prep/`, `scripts/build-jre.ts`                      | `server/settings.ts`, `server/update.ts` (lazy imports), `deno.json` (`build:jre`, `build:fat`, `release:fat`) |
| keychain    | `server/keychain.ts`, `helper/`, `jars/`, `scripts/compile-helpers.ts` | `server/repo.ts`, `server/settings.ts` (lazy imports), `scripts/compile.ts`                                    |
| components  | `server/components.ts`                                                 | `server.ts`, `server/settings.ts`, `server/update.ts` (lazy imports)                                           |
| updates     | `server/update.ts`, `scripts/publish.ts`                               | `server.ts` (lazy import), `deno.json` (`publish`, `release*`), `ui/js/update.js`                              |

(Deletion is optional — the lazy `import("./…")` sites are cheap to find; a flag left off is just as clean at runtime.)

## Environment variables

All app-specific variables use `APP.envPrefix` (`MY_APP` in the unedited template):

| Variable                                                         | Effect                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `<PREFIX>_PORT`                                                  | fixed server port (default: random)                              |
| `<PREFIX>_DATA_DIR`                                              | override the per-OS data dir (components)                        |
| `<PREFIX>_OPEN`                                                  | file to open on launch (set by `--open`, read via `/api/status`) |
| `<PREFIX>_UPDATE_URL`                                            | override `repo.updateBase` (mirrors, testing)                    |
| `<PREFIX>_SKIP_PREREQS`                                          | `1` skips the startup prerequisite gate (prerequisites feature)  |
| `<PREFIX>_FAIL_PREREQS`                                          | `1` forces every prerequisite to fail (gate hint/UI review)      |
| `<PREFIX>_ALLOW_UNNOTARIZED`                                     | let publish accept an un-stapled macOS app (test repos)          |
| `<PREFIX>_MACOS_KEYCHAIN`                                        | target a specific macOS keychain file (testing)                  |
| `<PREFIX>_REPO_*`                                                | repository credentials (see `server/repo.ts`)                    |
| `DES_KEYCHAIN`, `DES_KEYCHAIN_PW`                                | keychain file + unlock password (keychain feature)               |
| `APP_SIGN_IDENTITY`, `APP_NOTARY_PROFILE`, `APP_NOTARY_KEYCHAIN` | notarize.sh overrides                                            |

## License & attribution

Template code: add a `LICENSE` matching your organization's policy. Vendored/embedded third-party components keep their
own licenses:

- **iOS 26 design tokens** (`ui/vendor/ios26/`) — MIT (open-source reimplementation of Apple's system styles).
- **Lucide** icons (`ui/vendor/lucide.min.js`) — ISC.
- **`jars/keychain-cli.jar`** — denkbares KeychainCLI (keychain feature); proprietary.
- **Java runtime** (embedded in fat builds) — Eclipse Temurin, GPLv2 with Classpath Exception.
