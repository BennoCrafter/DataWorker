<div align="center">

<img src="icon.png" alt="DataWorker logo" height="200" />

# DataWorker

</div>

A replacement for the old Bento (databse) app (FileMaker/Claris, discontinued 2013) — for anyone who needs a simple, local database replacement.

It works the same way the original did: a **library** is a named collection (e.g.
"Movies", "Books") with whatever fields you give it — text, notes, numbers, currency,
dates, or a yes/no checkbox. Each library shows as a sortable, searchable table; click any cell
to edit it. Bento could export a library to CSV — this app can read those exports back in
(**Import CSV**, ⌘I) to recreate the same library with its fields guessed automatically, and
export any library back out the same way (the CSV export button in a library's toolbar).

Everything is stored locally on your Mac — one plain JSON file per library under
`~/Library/Application Support/dataworker/libraries/`

## Getting started

Download the latest release from the [releases page](https://github.com/BennoCrafter/DataWorker/releases).

or build it by yourself

1. `deno task build` — builds the app into a standalone executable.
2. `deno task start` — runs the app in its own window for development.
3. Click **+** in the sidebar to create a library from scratch, or the import icon next to it
   to load an old Bento CSV export.
3. Click a library to see its table; click a cell to edit; the **+ Neuer Eintrag** row at the
   bottom adds a record. The gear icon in the toolbar renames the library, adds/removes/
   renames fields, or deletes the library entirely.

## Project layout

| File                          | What's in it                                                   |
| ------------------------------ | ---------------------------------------------------------------- |
| `server/library.ts`            | The data model (libraries/fields/records) and its JSON storage |
| `server/csv.ts`                | Bento-CSV parsing, per-column type guessing, and export        |
| `server/library-routes.ts`     | The `/api/libraries*` and `/api/import-csv` HTTP routes         |
| `ui/js/library.js`             | The whole UI: sidebar, table, modals                            |


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
