/**
 * Boot and wiring: loads status + config, applies the theme, renders the chrome, and binds
 * the top-chrome buttons, global click-away handling and keyboard shortcuts.
 *
 * ADD YOUR APP'S BOOT + WIRING at the marked spots.
 */
import { $ } from "./util.js";
import { setConfig } from "./config.js";
import { state } from "./state.js";
import { renderActivity } from "./activity.js";
import { initUpdate } from "./update.js";
import { applyStatusLabels, ensureComponents } from "./status.js";
import { applyTheme, initSettings, openSettings, promptSetup, renderSettings } from "./settings.js";
import { ensurePrerequisites } from "./prereqs.js";
import { runCommand } from "./commands.js";
import { initLibraryApp } from "./library.js";

async function init() {
	// config first, so the theme applies to the prerequisites gate too
	const stored = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
	setConfig(stored);
	applyTheme();

	// the startup gate (prerequisites feature) — the app only boots once everything passes
	await ensurePrerequisites();

	const status = await fetch("/api/status").then((r) => r.json());
	applyStatusLabels(status);
	renderActivity();
	initSettings();

	await initLibraryApp();

	if (status.features?.components && status.componentsReady === false) {
		// first launch (or an aborted setup): components need downloading, which may need
		// repository credentials. If none are reachable yet, guide the user in Settings
		// instead of firing a download that can only fail. Otherwise download, then look
		// for updates.
		const settings = await fetch("/api/settings").then((r) => r.json()).catch(() => null);
		if (settings?.ok && settings.repo?.source === "none") {
			promptSetup(settings);
		} else {
			const ok = await ensureComponents();
			if (ok && status.features?.updates) initUpdate();
			else if (!ok) openSettings();
		}
	} else if (status.features?.updates) {
		initUpdate(); // background — shows the header Update button when something newer is published
	}
}
init();

$("activity-btn").onclick = (event) => {
	// stop the bubble: renderActivity() replaces the button's children, detaching event.target,
	// which would make the document handler below treat this click as "outside" and re-close it
	event.stopPropagation();
	state.showActivity = !state.showActivity;
	renderActivity();
};
document.addEventListener("click", (event) => {
	if (state.showActivity && !event.target.closest("#activity-wrap")) {
		state.showActivity = false;
		renderActivity();
	}
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
	"a": "toggle-activity",
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
