/**
 * Desktop entry point.
 *
 * Starts the HTTP server (server.ts) in a worker — the webview's native run loop blocks the
 * main thread, so the server must live elsewhere — then opens a desktop window on the UI.
 * Falls back to the system browser if the webview native library is unavailable (e.g. first
 * run without network access).
 */

import { APP } from "./app.config.ts";

// a file to open on launch — passed by the macOS document handler as `--open <path>` (or a bare
// path argument). Shared with the server via env, which the worker reads for /api/status.
const openIndex = Deno.args.indexOf("--open");
const openPath = openIndex !== -1 ? Deno.args[openIndex + 1] : Deno.args.find((a) => !a.startsWith("-"));
if (openPath) Deno.env.set(`${APP.envPrefix}_OPEN`, openPath);

const worker = new Worker(new URL("./server.ts", import.meta.url), { type: "module" });
const address = await new Promise<string>((resolve) => {
	worker.onmessage = (event) => resolve(event.data.address);
});

const cstr = (s: string) => new TextEncoder().encode(s + "\0");

// Linux: the GTK window gets neither a WM_CLASS nor an icon by itself. Set the program name
// before GTK initializes (first Webview construction) so WM_CLASS matches the .desktop entry
// shipped in the AppImage, and use its themed icon. Both are cosmetic — ignore failures.
if (Deno.build.os === "linux") {
	try {
		const glib = Deno.dlopen("libglib-2.0.so.0", {
			g_set_prgname: { parameters: ["buffer"], result: "void" },
		});
		glib.symbols.g_set_prgname(cstr(APP.id));
	} catch { /* cosmetic */ }
}

try {
	const { Webview, SizeHint } = await import("@webview/webview");
	const webview = new Webview(false, { width: APP.window.width, height: APP.window.height, hint: SizeHint.NONE });
	webview.title = APP.name;
	// macOS: install a real menu bar (libwebview never does). Beyond the menu itself, the Edit
	// menu's standard selectors are what make Cmd+A/C/V/X/Z work in the webview's text fields.
	// Own try/catch: a menu failure must neither block the launch nor trip the browser fallback.
	if (APP.features.macMenu && Deno.build.os === "darwin") {
		try {
			const icon = await Deno.readFile(new URL("./icon.png", import.meta.url)).catch(() => null);
			const { installMacMenu } = await import("./macos-menu.ts");
			installMacMenu(webview, { icon, updates: APP.features.updates });
		} catch (error) {
			console.error(`macOS menu unavailable (${error instanceof Error ? error.message : error})`);
		}
	}
	// Windows: an optional classic menu bar (WebView2 already handles the editing shortcuts,
	// so unlike the macOS menu this is purely additive). Same guard: never block the launch.
	if (APP.features.windowsMenu && Deno.build.os === "windows") {
		try {
			const { installWindowsMenu } = await import("./windows-menu.ts");
			installWindowsMenu(webview, { updates: APP.features.updates });
		} catch (error) {
			console.error(`Windows menu unavailable (${error instanceof Error ? error.message : error})`);
		}
	}
	if (Deno.build.os === "linux") {
		try {
			const gtk = Deno.dlopen("libgtk-4.so.1", {
				gtk_window_set_icon_name: { parameters: ["pointer", "buffer"], result: "void" },
			});
			gtk.symbols.gtk_window_set_icon_name(webview.unsafeWindowHandle, cstr(APP.id));
		} catch { /* cosmetic */ }
	}
	webview.navigate(address);
	webview.run(); // blocks until the window is closed
	Deno.exit(0);
} catch (error) {
	console.error(`webview unavailable (${error instanceof Error ? error.message : error})`);
	console.error(`falling back to the system browser: ${address}`);
	const opener = Deno.build.os === "darwin" ? "open" : Deno.build.os === "windows" ? "explorer" : "xdg-open";
	await new Deno.Command(opener, { args: [address] }).output().catch(() => {});
	await new Promise(() => {}); // keep the server alive until Ctrl+C
}
