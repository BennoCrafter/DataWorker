<div align="center">

<img src="icon.png" alt="Bento logo" height="200" />

# Bento

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
`~/Library/Application Support/bento/libraries/`, nothing is uploaded anywhere.

## Getting started

1. `deno task start` — runs the app in its own window.
2. Click **+** in the sidebar to create a library from scratch, or the import icon next to it
   to load an old Bento CSV export.
3. Click a library to see its table; click a cell to edit; the **+ Neuer Eintrag** row at the
   bottom adds a record. The gear icon in the toolbar renames the library, adds/removes/
   renames fields, or deletes the library entirely.

## Project layout

This is built on a Deno + native-webview desktop app template — see `docs/internals.md` for
how that scaffold works. The Bento-specific pieces:

| File                          | What's in it                                                   |
| ------------------------------ | ---------------------------------------------------------------- |
| `server/library.ts`            | The data model (libraries/fields/records) and its JSON storage |
| `server/csv.ts`                | Bento-CSV parsing, per-column type guessing, and export        |
| `server/library-routes.ts`     | The `/api/libraries*` and `/api/import-csv` HTTP routes         |
| `ui/js/library.js`             | The whole UI: sidebar, table, modals                            |

Everything else (webview window, macOS menu, settings popover, native file dialogs) is the
unmodified template scaffold — see its own `README.md`/`docs/internals.md` history for that
part. Only `features.macMenu` and `features.windowsMenu` are on in `app.config.ts`; the rest
(Java, keychain, downloaded components, self-update, startup prerequisites) are off — this app
doesn't need them.

## Commands

| Command           | What it does                                 |
| ------------------ | ----------------------------------------------- |
| `deno task start`  | Run the app in its native window                |
| `deno task serve`  | Run the same app in the system browser           |
| `deno task check`  | Type-check every entry point                     |
| `deno task build`  | Compile a standalone binary + `.app` (`dist/`)   |

`deno task build` produces an unsigned app — first launch needs a right-click ▸ Open (or
System Settings ▸ Privacy & Security ▸ Open Anyway) since it isn't notarized.
