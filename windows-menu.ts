/**
 * OPTIONAL FEATURE (features.windowsMenu): native Windows menu bar, via Deno FFI to user32.dll.
 *
 * Unlike on macOS this is purely additive chrome: WebView2 (Chromium) handles the standard
 * editing shortcuts (Ctrl+A/C/V/X/Z) in text fields by itself, and the app shortcuts already
 * work through the keydown table in ui/js/main.js. Turn it on when you want a classic Windows
 * menu bar; leave it off for a chromeless window (in-app menus).
 *
 * Mechanics: libwebview's Win32 window gets a real menu bar (CreateMenu/AppendMenuW/SetMenu).
 * Menu clicks arrive as WM_COMMAND messages at the window procedure, which libwebview owns —
 * so the window is subclassed (SetWindowLongPtrW GWLP_WNDPROC) with a Deno.UnsafeCallback that
 * handles WM_COMMAND and chains everything else to the original proc. The callback fires on
 * the main thread inside the message pump while the isolate is blocked in webview.run() — the
 * same re-entry pattern the macOS menu (and the webview library's own bind()) relies on — and
 * forwards the command into the page via webview.eval → globalThis.__nativeMenu
 * (ui/js/commands.js), so menu items and keyboard shortcuts share one command registry.
 *
 * The accelerator texts on the items ("Ctrl+," …) are display-only: real Win32 accelerator
 * tables would need TranslateAccelerator inside the message loop, which libwebview owns — the
 * keys themselves are handled by the in-page shortcut table instead, which is already the
 * Windows implementation of the shortcuts.
 *
 * ADD YOUR APP'S MENUS in installWindowsMenu below — dispatchItem() forwards any {cmd: …}
 * object into the page's command registry.
 *
 * installWindowsMenu must run on the main thread after the Webview exists (the HWND is
 * needed) and before webview.run(). It throws on any FFI anomaly; the caller (main.ts) treats
 * the menu as optional and must not let a failure block the launch.
 */
import type { Webview } from "@webview/webview";
import { APP } from "./app.config.ts";

export interface WindowsMenuOptions {
	/** Whether the updates feature is on — adds "Check for Updates…" to the File menu. */
	updates?: boolean;
}

// Win32 constants
const MF_STRING = 0x0000;
const MF_POPUP = 0x0010;
const MF_SEPARATOR = 0x0800;
const GWLP_WNDPROC = -4;
const WM_CLOSE = 0x0010;
const WM_COMMAND = 0x0111;

const SYMBOLS = {
	CreateMenu: { parameters: [], result: "pointer" },
	CreatePopupMenu: { parameters: [], result: "pointer" },
	AppendMenuW: { parameters: ["pointer", "u32", "usize", "buffer"], result: "i32" },
	SetMenu: { parameters: ["pointer", "pointer"], result: "i32" },
	DrawMenuBar: { parameters: ["pointer"], result: "i32" },
	SetWindowLongPtrW: { parameters: ["pointer", "i32", "pointer"], result: "pointer" },
	CallWindowProcW: { parameters: ["pointer", "pointer", "u32", "usize", "isize"], result: "isize" },
	PostMessageW: { parameters: ["pointer", "u32", "usize", "isize"], result: "i32" },
} as const;

let sym: Deno.DynamicLibrary<typeof SYMBOLS>["symbols"];

/** UTF-16LE, null-terminated — what the …W entry points expect. */
function wstr(text: string): Uint8Array<ArrayBuffer> {
	const buffer = new Uint8Array((text.length + 1) * 2);
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		buffer[2 * i] = code & 0xff;
		buffer[2 * i + 1] = code >> 8;
	}
	return buffer;
}

function pointerValue(pointer: Deno.PointerValue): bigint {
	return BigInt(Deno.UnsafePointer.value(pointer));
}

// menu-command ids: EXIT is handled natively (WM_CLOSE), everything else dispatches into the
// page. Ids start above the small reserved dialog ids (IDOK…) out of caution.
const EXIT_ID = 90;
const FIRST_COMMAND_ID = 100;
const commands = new Map<number, Record<string, unknown>>();
let nextCommandId = FIRST_COMMAND_ID;

export function addSubmenu(parent: Deno.PointerValue, title: string): Deno.PointerValue {
	const submenu = sym.CreatePopupMenu();
	if (!submenu) throw new Error("CreatePopupMenu failed");
	sym.AppendMenuW(parent, MF_POPUP, pointerValue(submenu), wstr(title));
	return submenu;
}

export function addSeparator(menu: Deno.PointerValue) {
	sym.AppendMenuW(menu, MF_SEPARATOR, 0n, wstr(""));
}

/**
 * Item that forwards a command object into the page via globalThis.__nativeMenu. The optional
 * accelerator ("Ctrl+,") is shown right-aligned on the item; the key itself is implemented by
 * the in-page shortcut table (see the module comment).
 */
export function dispatchItem(
	menu: Deno.PointerValue,
	title: string,
	command: Record<string, unknown>,
	accelerator = "",
) {
	const id = nextCommandId++;
	commands.set(id, command);
	sym.AppendMenuW(menu, MF_STRING, BigInt(id), wstr(accelerator ? `${title}\t${accelerator}` : title));
}

// module-scope for the process lifetime — a GC'd callback would crash the app on the next
// window message, so it is assigned once and never released
let wndProc: Deno.UnsafeCallback<{
	parameters: ["pointer", "u32", "usize", "isize"];
	result: "isize";
}>;

/** Subclasses the webview window so WM_COMMAND (menu clicks) reaches us; the rest chains on. */
function subclassWindow(webview: Webview, hwnd: Deno.PointerValue) {
	let originalProc: Deno.PointerValue = null;
	wndProc = new Deno.UnsafeCallback(
		{ parameters: ["pointer", "u32", "usize", "isize"], result: "isize" },
		(window, message, wParam, lParam) => {
			if (message === WM_COMMAND) {
				const w = BigInt(wParam);
				const source = Number((w >> 16n) & 0xffffn); // 0 = a menu item
				const id = Number(w & 0xffffn);
				if (source === 0) {
					if (id === EXIT_ID) {
						// quit through the window-close path — the app's one tested shutdown
						// route (webview.run() returns → main.ts exits)
						sym.PostMessageW(hwnd, WM_CLOSE, 0n, 0n);
						return 0n;
					}
					const command = commands.get(id);
					if (command) {
						// the guard drops clicks that arrive before the page has loaded
						webview.eval(`globalThis.__nativeMenu && globalThis.__nativeMenu(${JSON.stringify(command)})`);
						return 0n;
					}
				}
			}
			return sym.CallWindowProcW(originalProc, window, message, wParam, lParam);
		},
	);
	originalProc = sym.SetWindowLongPtrW(hwnd, GWLP_WNDPROC, wndProc.pointer);
	if (!originalProc) throw new Error("could not subclass the webview window (SetWindowLongPtrW failed)");
}

export function installWindowsMenu(webview: Webview, options: WindowsMenuOptions = {}): void {
	if (Deno.build.os !== "windows") return;
	sym = Deno.dlopen("user32.dll", SYMBOLS).symbols;

	const hwnd = webview.unsafeWindowHandle;
	if (!hwnd) throw new Error("no window handle");
	subclassWindow(webview, hwnd);

	const bar = sym.CreateMenu();
	if (!bar) throw new Error("CreateMenu failed");

	// File
	const fileMenu = addSubmenu(bar, "&File");
	dispatchItem(fileMenu, "Settings…", { cmd: "settings" }, "Ctrl+,");
	if (options.updates) dispatchItem(fileMenu, "Check for Updates…", { cmd: "check-updates" });
	addSeparator(fileMenu);
	sym.AppendMenuW(fileMenu, MF_STRING, BigInt(EXIT_ID), wstr("E&xit\tAlt+F4"));

	dispatchItem(fileMenu, "New Library…", { cmd: "new-library" }, "Ctrl+Shift+N");
	dispatchItem(fileMenu, "New Record", { cmd: "new-record" }, "Ctrl+N");
	addSeparator(fileMenu);
	dispatchItem(fileMenu, "Import CSV…", { cmd: "import-csv" }, "Ctrl+I");

	// View
	const viewMenu = addSubmenu(bar, "&View");
	const themeMenu = addSubmenu(viewMenu, "Appearance");
	dispatchItem(themeMenu, "Light", { cmd: "theme-light" });
	dispatchItem(themeMenu, "Dark", { cmd: "theme-dark" });

	// Help
	const helpMenu = addSubmenu(bar, "&Help");
	dispatchItem(helpMenu, `${APP.name} Help`, { cmd: "help" });
	addSeparator(helpMenu);
	dispatchItem(helpMenu, `About ${APP.name}`, { cmd: "about" });

	// attach — the client area shrinks by the menu height; libwebview's own WM_SIZE handling
	// (still reached through the subclass chain) resizes the WebView2 control to match
	sym.SetMenu(hwnd, bar);
	sym.DrawMenuBar(hwnd);
}
