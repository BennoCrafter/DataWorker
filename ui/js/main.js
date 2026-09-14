/**
 * Boot and wiring: loads config, applies the theme, renders the chrome, and binds global
 * click-away handling and keyboard shortcuts.
 *
 * The template's component-download / self-update / activity-popover machinery is left out of
 * this app's wiring on purpose — app.config.ts has those features off, so it would never have
 * anything to show.
 */
import { refreshIcons } from "./util.js";
import { setConfig } from "./config.js";
import { state } from "./state.js";
import { applyStatusLabels } from "./status.js";
import { applyTheme, initSettings, renderSettings } from "./settings.js";
import { ensurePrerequisites } from "./prereqs.js";
import { runCommand } from "./commands.js";
import { initLibraryApp } from "./library.js";

async function init() {
	// config first, so the theme applies to the prerequisites gate too
	const stored = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
	setConfig(stored);
	applyTheme();

	// converts the icons already in index.html (lucide.min.js loads before this module script
	// runs, so this only needs to happen once, this early) — without it they stay invisible
	// until something else happens to call refreshIcons() later, e.g. opening Settings
	refreshIcons();

	// the startup gate (prerequisites feature) — the app only boots once everything passes
	await ensurePrerequisites();

	const status = await fetch("/api/status").then((r) => r.json());
	applyStatusLabels(status);
	initSettings();

	await initLibraryApp();
}
init();

document.addEventListener("click", (event) => {
	// a detached target means a popover-internal click whose handler re-rendered the popover
	// (replacing the clicked button) — that is never a click-away
	if (state.showSettings && event.target.isConnected && !event.target.closest("#settings-wrap")) {
		state.showSettings = false;
		renderSettings();
	}
});

// the native macOS menu bar forwards its items here (see macos-menu.ts)
globalThis.__nativeMenu = runCommand;

// app shortcuts (Cmd on macOS / Ctrl elsewhere) — on macOS the native menu usually consumes
// these key equivalents first and dispatches the same command, so this table is the
// Windows/Linux implementation and the macOS fallback
const MOD_SHORTCUTS = {
	",": "settings",
	"n": "new-record",
	"i": "import-csv",
};
const MOD_SHIFT_SHORTCUTS = {
	"n": "new-library",
};

document.addEventListener("keydown", (event) => {
	// Cmd/Ctrl+R would reload the webview — suppress it
	if ((event.metaKey || event.ctrlKey) && event.key === "r" && !event.altKey) {
		event.preventDefault();
	}
	if ((event.metaKey || event.ctrlKey) && !event.altKey) {
		const key = event.key.toLowerCase();
		const command = event.shiftKey ? MOD_SHIFT_SHORTCUTS[key] : MOD_SHORTCUTS[key];
		if (command) {
			event.preventDefault();
			runCommand(command);
		}
	}
});
