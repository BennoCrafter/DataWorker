/**
 * OPTIONAL FEATURE (features.macMenu): native macOS menu bar, via Deno FFI to the Objective-C
 * runtime.
 *
 * libwebview creates the NSApplication but never installs a main menu — and on macOS the
 * standard editing shortcuts (Cmd+A/C/V/X/Z) are delivered to the focused control through
 * main-menu key equivalents, so without an Edit menu they do nothing in the WKWebView's
 * text fields. Building the menu here — Edit with the standard nil-target selectors, plus
 * the app's own commands — fixes those shortcuts and gives the app a real menu bar.
 *
 * App-specific items target a runtime-created menu-handler class whose action IMP is a
 * Deno.UnsafeCallback. It fires on the main thread inside [NSApp run] while the isolate is
 * blocked in webview.run() — the same re-entry pattern the webview library's own bind()
 * relies on — and forwards the command into the page via webview.eval →
 * globalThis.__nativeMenu (ui/js/commands.js).
 *
 * ADD YOUR APP'S MENUS in installMacMenu below — dispatchItem() forwards any {cmd: …} object
 * into the page's command registry, standardItem() wires the standard responder-chain
 * selectors.
 *
 * installMacMenu must run on the main thread after the Webview exists (NSApplication is
 * created) and before webview.run(). It throws on any FFI anomaly; the caller (main.ts)
 * treats the menu as optional and must not let a failure block the launch.
 */
import type { Webview } from "@webview/webview";
import { APP } from "./app.config.ts";

export interface MacMenuOptions {
	/** PNG bytes for the runtime Dock icon (the detached binary has no bundle icon). */
	icon?: Uint8Array<ArrayBuffer> | null;
	/** Whether the updates feature is on — adds "Check for Updates…" to the app menu. */
	updates?: boolean;
}

// NSEventModifierFlags for -[NSMenuItem setKeyEquivalentModifierMask:]
const CMD = 1 << 20;
const SHIFT = 1 << 17;
const OPT = 1 << 19;
const CTRL = 1 << 18;
export { CMD, CTRL, OPT, SHIFT };

// objc_msgSend is variadic and must be bound once per call-site signature (a hard ABI
// requirement on arm64) — hence the msg_* aliases of the same symbol.
const SYMBOLS = {
	objc_getClass: { parameters: ["buffer"], result: "pointer" },
	sel_registerName: { parameters: ["buffer"], result: "pointer" },
	objc_allocateClassPair: { parameters: ["pointer", "buffer", "usize"], result: "pointer" },
	class_addMethod: { parameters: ["pointer", "pointer", "pointer", "buffer"], result: "u8" },
	objc_registerClassPair: { parameters: ["pointer"], result: "void" },
	msg_id: { name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "pointer" },
	msg_id_id: { name: "objc_msgSend", parameters: ["pointer", "pointer", "pointer"], result: "pointer" },
	msg_id_buf: { name: "objc_msgSend", parameters: ["pointer", "pointer", "buffer"], result: "pointer" },
	msg_void_id: { name: "objc_msgSend", parameters: ["pointer", "pointer", "pointer"], result: "void" },
	msg_void_u64: { name: "objc_msgSend", parameters: ["pointer", "pointer", "u64"], result: "void" },
	msg_void_i64: { name: "objc_msgSend", parameters: ["pointer", "pointer", "i64"], result: "void" },
	msg_i64: { name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "i64" },
	msg_id_id_sel_id: {
		name: "objc_msgSend",
		parameters: ["pointer", "pointer", "pointer", "pointer", "pointer"],
		result: "pointer",
	},
	msg_id_buf_u64: { name: "objc_msgSend", parameters: ["pointer", "pointer", "buffer", "u64"], result: "pointer" },
	msg_void_sel_id_f64: {
		name: "objc_msgSend",
		parameters: ["pointer", "pointer", "pointer", "pointer", "f64"],
		result: "void",
	},
} as const;

let sym: Deno.DynamicLibrary<typeof SYMBOLS>["symbols"];

const cstr = (s: string) => new TextEncoder().encode(s + "\0");

function cls(name: string): Deno.PointerValue {
	const c = sym.objc_getClass(cstr(name));
	if (!c) throw new Error(`objc class ${name} not found`);
	return c;
}

const selCache = new Map<string, Deno.PointerValue>();
function sel(name: string): Deno.PointerValue {
	let s = selCache.get(name);
	if (s === undefined) {
		s = sym.sel_registerName(cstr(name));
		selCache.set(name, s);
	}
	return s;
}

// +1 owned NSString, deliberately never released — everything built here lives as long as
// the process, and owned references avoid autoreleased objects outside a draining pool
function nsstr(text: string): Deno.PointerValue {
	return sym.msg_id_buf(sym.msg_id(cls("NSString"), sel("alloc")), sel("initWithUTF8String:"), cstr(text));
}

function newMenu(title: string): Deno.PointerValue {
	return sym.msg_id_id(sym.msg_id(cls("NSMenu"), sel("alloc")), sel("initWithTitle:"), nsstr(title));
}

function newItem(title: string, action: Deno.PointerValue | null, key = "", mask = CMD): Deno.PointerValue {
	const item = sym.msg_id_id_sel_id(
		sym.msg_id(cls("NSMenuItem"), sel("alloc")),
		sel("initWithTitle:action:keyEquivalent:"),
		nsstr(title),
		action,
		nsstr(key),
	);
	if (key) sym.msg_void_u64(item, sel("setKeyEquivalentModifierMask:"), BigInt(mask));
	return item;
}

function addItem(menu: Deno.PointerValue, item: Deno.PointerValue) {
	sym.msg_void_id(menu, sel("addItem:"), item);
}

export function addSeparator(menu: Deno.PointerValue) {
	addItem(menu, sym.msg_id(cls("NSMenuItem"), sel("separatorItem")));
}

export function addSubmenu(parent: Deno.PointerValue, title: string): Deno.PointerValue {
	const holder = newItem(title, null);
	addItem(parent, holder);
	const submenu = newMenu(title);
	sym.msg_void_id(holder, sel("setSubmenu:"), submenu);
	return submenu;
}

/** Item wired to a responder-chain selector (nil target) — or an explicit target when given. */
export function standardItem(menu: Deno.PointerValue, title: string, action: string, key = "", mask = CMD) {
	addItem(menu, newItem(title, sel(action), key, mask));
}

// module-scope for the process lifetime — a GC'd callback or handler would crash the app on
// the next menu click, so these are assigned once and never released
let menuActionImp: Deno.UnsafeCallback<{ parameters: ["pointer", "pointer", "pointer"]; result: "void" }>;
let handler: Deno.PointerValue;
const commands: Record<string, unknown>[] = [];

function createHandler(webview: Webview) {
	menuActionImp = new Deno.UnsafeCallback(
		{ parameters: ["pointer", "pointer", "pointer"], result: "void" }, // (id self, SEL _cmd, id sender)
		(_self, _cmd, sender) => {
			const command = commands[Number(sym.msg_i64(sender, sel("tag")))];
			// the guard drops clicks that arrive before the page has loaded
			if (command) webview.eval(`globalThis.__nativeMenu && globalThis.__nativeMenu(${JSON.stringify(command)})`);
		},
	);
	const handlerClass = sym.objc_allocateClassPair(cls("NSObject"), cstr("AppMenuHandler"), 0n);
	if (!handlerClass) throw new Error("could not allocate AppMenuHandler class");
	sym.class_addMethod(handlerClass, sel("menuAction:"), menuActionImp.pointer, cstr("v@:@"));
	sym.objc_registerClassPair(handlerClass);
	handler = sym.msg_id(handlerClass, sel("new"));
}

/** Item that forwards a command object into the page via globalThis.__nativeMenu. */
export function dispatchItem(
	menu: Deno.PointerValue,
	title: string,
	command: Record<string, unknown>,
	key = "",
	mask = CMD,
) {
	const item = newItem(title, sel("menuAction:"), key, mask);
	sym.msg_void_id(item, sel("setTarget:"), handler);
	sym.msg_void_i64(item, sel("setTag:"), BigInt(commands.push(command) - 1));
	addItem(menu, item);
}

export function installMacMenu(webview: Webview, options: MacMenuOptions = {}): void {
	if (Deno.build.os !== "darwin") return;
	sym = Deno.dlopen("/usr/lib/libobjc.A.dylib", SYMBOLS).symbols;

	const app = sym.msg_id(cls("NSApplication"), sel("sharedApplication"));
	if (!app) throw new Error("NSApplication not available");

	// the visible app-menu name derives from the process name (the packaged binary is named
	// after the app since make-app.sh renames it; dev runs are "deno") — set it before
	// [NSApp run] realizes the menu bar
	sym.msg_void_id(sym.msg_id(cls("NSProcessInfo"), sel("processInfo")), sel("setProcessName:"), nsstr(APP.name));

	// Dock icon: the .app launches the binary detached, so the GUI process has no app bundle
	// and would show the generic executable icon — set it at runtime from the shipped png
	// (NSData/NSImage own their copies of the bytes)
	const icon = options.icon;
	if (icon && icon.length > 0) {
		const data = sym.msg_id_buf_u64(
			sym.msg_id(cls("NSData"), sel("alloc")),
			sel("initWithBytes:length:"),
			icon,
			BigInt(icon.length),
		);
		const image = sym.msg_id_id(sym.msg_id(cls("NSImage"), sel("alloc")), sel("initWithData:"), data);
		if (image) sym.msg_void_id(app, sel("setApplicationIconImage:"), image);
	}

	createHandler(webview);
	const mainMenu = newMenu("");

	// App menu — always the first item of the main menu
	const appMenu = addSubmenu(mainMenu, APP.name);
	dispatchItem(appMenu, `About ${APP.name}`, { cmd: "about" });
	addSeparator(appMenu);
	dispatchItem(appMenu, "Settings…", { cmd: "settings" }, ",");
	if (options.updates) dispatchItem(appMenu, "Check for Updates…", { cmd: "check-updates" });
	addSeparator(appMenu);
	standardItem(appMenu, `Hide ${APP.name}`, "hide:", "h");
	standardItem(appMenu, "Hide Others", "hideOtherApplications:", "h", CMD | OPT);
	standardItem(appMenu, "Show All", "unhideAllApplications:");
	addSeparator(appMenu);
	// quit through the window-close path — the app's one tested shutdown route (webview.run()
	// returns → main.ts exits); targeted at the window so it works while miniaturized too
	const quit = newItem(`Quit ${APP.name}`, sel("performClose:"), "q");
	sym.msg_void_id(quit, sel("setTarget:"), webview.unsafeWindowHandle);
	addItem(appMenu, quit);

	const fileMenu = addSubmenu(mainMenu, "Ablage");
	dispatchItem(fileMenu, "Neue Bibliothek…", { cmd: "new-library" }, "n", CMD | SHIFT);
	dispatchItem(fileMenu, "Neuer Eintrag", { cmd: "new-record" }, "n");
	addSeparator(fileMenu);
	dispatchItem(fileMenu, "CSV importieren…", { cmd: "import-csv" }, "i");

	// Edit — the standard nil-target selectors; without these, WKWebView never receives
	// Cmd+A/C/V/X/Z in text fields (the bug this module exists to fix)
	const editMenu = addSubmenu(mainMenu, "Edit");
	standardItem(editMenu, "Undo", "undo:", "z");
	standardItem(editMenu, "Redo", "redo:", "z", CMD | SHIFT);
	addSeparator(editMenu);
	standardItem(editMenu, "Cut", "cut:", "x");
	standardItem(editMenu, "Copy", "copy:", "c");
	standardItem(editMenu, "Paste", "paste:", "v");
	standardItem(editMenu, "Select All", "selectAll:", "a");

	// View
	const viewMenu = addSubmenu(mainMenu, "View");
	const themeMenu = addSubmenu(viewMenu, "Appearance");
	dispatchItem(themeMenu, "Light", { cmd: "theme-light" });
	dispatchItem(themeMenu, "Dark", { cmd: "theme-dark" });

	// Window
	const windowMenu = addSubmenu(mainMenu, "Window");
	standardItem(windowMenu, "Minimize", "performMiniaturize:", "m");
	standardItem(windowMenu, "Zoom", "performZoom:");
	addSeparator(windowMenu);
	standardItem(windowMenu, "Enter Full Screen", "toggleFullScreen:", "f", CTRL | CMD);

	// Help
	const helpMenu = addSubmenu(mainMenu, "Help");
	dispatchItem(helpMenu, `${APP.name} Help`, { cmd: "help" });

	sym.msg_void_id(app, sel("setMainMenu:"), mainMenu);
	sym.msg_void_id(app, sel("setWindowsMenu:"), windowMenu);
	sym.msg_void_id(app, sel("setHelpMenu:"), helpMenu);
	// belt-and-braces app-menu title: set it now, and re-apply once the run loop has started —
	// AppKit stamps the app-menu title from the process name when [NSApp run] realizes the menu
	// bar, which would overwrite a title set only before launch (dev runs show "deno" otherwise)
	sym.msg_void_id(appMenu, sel("setTitle:"), nsstr(APP.name));
	sym.msg_void_sel_id_f64(
		appMenu,
		sel("performSelector:withObject:afterDelay:"),
		sel("setTitle:"),
		nsstr(APP.name),
		0,
	);
}
