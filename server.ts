/**
 * Local HTTP server behind the desktop window — the route table and the two run modes.
 *
 * The CORE routes (status, settings, config, native pickers, reveal, static ui/) are always
 * on; the OPTIONAL updates feature contributes its routes only when enabled in app.config.ts —
 * the module is loaded lazily, so it costs nothing at startup if turned off:
 *
 * - server/update.ts      (features.updates)    in-app self-update + restart
 * - server/settings.ts    settings snapshot
 * - server/system.ts      native dialogs, reveal, user config
 * - server/http.ts        JSON/NDJSON responses, static files; paths.ts: fs helpers
 *
 * ADD YOUR APP'S ROUTES in the marked spots below, with the feature logic in new server/
 * modules — this file should stay a thin route table.
 *
 * Runs in two modes:
 * - as a Worker spawned by main.ts (posts its address back, main thread shows the webview)
 * - standalone via `deno task serve` (prints the URL and opens the system browser)
 */

import { APP, appEnv, validateFeatures } from "./app.config.ts";
import { json, serveStatic, streamResponse } from "./server/http.ts";
import { currentVersion } from "./server/version.ts";
import {
	handleConfigGet,
	handleConfigSave,
	handleOpenUrl,
	handlePickFile,
	handlePickFolder,
	handleReveal,
} from "./server/system.ts";
import { handleSettingsGet } from "./server/settings.ts";
import { handleImportCsv, handleLibraryApi } from "./server/library-routes.ts";

for (const warning of validateFeatures()) console.warn(`⚠️  ${warning}`);

// optional feature — loaded once here, only when enabled
const updates = APP.features.updates ? await import("./server/update.ts") : null;

const server = Deno.serve(
	{ hostname: "127.0.0.1", port: Number(appEnv("PORT") ?? 0), onListen: () => {} },
	async (request) => {
		const url = new URL(request.url);

		// same-origin guard: block cross-origin browser requests to this local port
		const origin = request.headers.get("origin");
		if (origin && origin !== url.origin) return new Response("forbidden", { status: 403 });

		try {
			if (request.method === "GET") {
				if (url.pathname === "/api/status") {
					return json({
						ok: true,
						name: APP.name,
						features: APP.features,
						version: (await currentVersion())?.version ?? null,
						os: Deno.build.os,
						// a file the OS asked us to open on launch (macOS document handler)
						openOnStart: appEnv("OPEN") || null,
					});
				}
				if (url.pathname === "/api/settings") return await handleSettingsGet();
				if (url.pathname === "/api/config") return await handleConfigGet();
				if (updates && url.pathname === "/api/update") return json({ ok: true, ...await updates.checkForUpdate() });
				// ── your app's GET routes here ─────────────────────────────────────────
				const libraryGet = await handleLibraryApi(request, url);
				if (libraryGet) return libraryGet;
				return await serveStatic(url.pathname);
			}
			if (request.method === "POST") {
				switch (url.pathname) {
					case "/api/config":
						return await handleConfigSave(request);
					case "/api/pick-folder":
						return await handlePickFolder();
					case "/api/pick-file":
						return await handlePickFile(request);
					case "/api/reveal":
						return await handleReveal(request);
					case "/api/open-url":
						return await handleOpenUrl(request);
					case "/api/import-csv":
						return await handleImportCsv();
						// ── your app's POST routes here ────────────────────────────────────
				}
				const libraryPost = await handleLibraryApi(request, url);
				if (libraryPost) return libraryPost;
				if (updates && url.pathname === "/api/update/apply") {
					return streamResponse((emit) => updates.applyUpdate(emit));
				}
				if (updates && url.pathname === "/api/restart") {
					// quit this instance and start the swapped-in app — only on explicit user request
					return json(updates.requestRestart());
				}
			}
			return new Response("not found", { status: 404 });
		} catch (error) {
			return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
		}
	},
);

const address = `http://127.0.0.1:${server.addr.port}/`;

// note: import.meta.main is true for a worker entry module too — detect the worker
// context via its postMessage global instead
if ("postMessage" in globalThis) {
	// worker mode: hand the address to main.ts, which shows the webview window
	(globalThis as unknown as Worker).postMessage({ address });
} else {
	// standalone mode: print the URL and open the system browser
	console.log(`${APP.id} running at ${address}`);
	const opener = Deno.build.os === "darwin" ? "open" : Deno.build.os === "windows" ? "explorer" : "xdg-open";
	new Deno.Command(opener, { args: [address] }).output().catch(() => {});
}
