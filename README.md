<div align="center">

<img src="icon.png" alt="DataWorker logo" height="200" />

# DataWorker

</div>

A small replacement for the old Bento app (FileMaker/Claris, discontinued 2013) — for anyone
who still has it running on an old Mac and needs it to keep working on a new one.

It works the same way the original did: a **library** is a named collection (e.g.
"Kochbücher", "Zinnfiguren") with whatever fields you give it — text, notes, numbers, currency,
dates, or a yes/no checkbox. Each library shows as a sortable, searchable table; click any cell
to edit it. Bento could export a library to CSV — this app can read those exports back in
(**Import CSV**, ⌘I) to recreate the same library with its fields guessed automatically, and
export any library back out the same way (the CSV export button in a library's toolbar).

Everything is stored locally on your Mac — one plain JSON file per library under
`~/Library/Application Support/dataworker/libraries/`, nothing is uploaded anywhere.

## Getting started

1. `deno task start` — runs the app in its own window.
2. Click **+** in the sidebar to create a library from scratch, or the import icon next to it
   to load an old Bento CSV export.
3. Click a library to see its table; click a cell to edit; the **+ Neuer Eintrag** row at the
   bottom adds a record. The gear icon in the toolbar renames the library, adds/removes/
   renames fields, or deletes the library entirely.

## Project layout

This is built on a Deno + native-webview desktop app template — see `docs/internals.md` for
how that scaffold works. The DataWorker-specific pieces:

| File                          | What's in it                                                   |
| ------------------------------ | ---------------------------------------------------------------- |
| `server/library.ts`            | The data model (libraries/fields/records) and its JSON storage |
| `server/csv.ts`                | Bento-CSV parsing, per-column type guessing, and export        |
| `server/library-routes.ts`     | The `/api/libraries*` and `/api/import-csv` HTTP routes         |
| `ui/js/library.js`             | The whole UI: sidebar, table, modals                            |

Everything else (webview window, macOS menu, settings popover, native file dialogs, self-
update) is the unmodified template scaffold — see its own `README.md`/`docs/internals.md`
history for that part. `features.macMenu`, `features.windowsMenu` and `features.updates` are on
in `app.config.ts`; the rest (Java, keychain, downloaded components, startup prerequisites) are
off — this app doesn't need them.

## Updates

`features.updates` is on, pointed at this repo's own `releases` branch on GitHub
(`app.config.ts`'s `repo.updateBase`) — the app checks
`raw.githubusercontent.com/BennoCrafter/DataWorker/releases/manifest-mac-aarch64.json` in the
background and offers an "Update" button when it's newer than the running build. Nothing
installs without that explicit click, and a downloaded update waits for a further explicit
"Restart Now" before it takes effect.

To ship a new build:

```sh
deno task release   # build → notarize → publish, in one go
```

`deno task publish` (part of `release`, or run alone after a manual `build` + `notarize`)
force-pushes a single fresh commit holding just the zipped `.app` and its manifest to the
`releases` branch — see `scripts/publish.ts` for why (GitHub Releases' upload API doesn't fit
the template's plain-PUT uploader, and the branch is deliberately history-free so it doesn't
grow a new ~60MB blob on every publish). Never edit that branch by hand.

## Commands

| Command              | What it does                                              |
| --------------------- | ------------------------------------------------------------ |
| `deno task start`     | Run the app in its native window                            |
| `deno task serve`     | Run the same app in the system browser                       |
| `deno task check`     | Type-check every entry point                                 |
| `deno task build`     | Compile a standalone binary + `.app` (`dist/`)               |
| `deno task notarize`  | Sign + notarize + staple the built `.app` (needs a Developer ID) |
| `deno task publish`   | Push the built (and notarized) app to the `releases` branch  |
| `deno task release`   | `build` → `notarize` → `publish`                              |
