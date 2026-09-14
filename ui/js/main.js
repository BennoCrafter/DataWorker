/**
 * Boot and wiring: loads config, applies the theme, renders the chrome, and binds the update
 * button, global click-away handling and keyboard shortcuts.
 */
import { $, refreshIcons, startDrag } from "./util.js";
import { config, saveConfig, setConfig } from "./config.js";
import { applyStaticTranslations, onLanguageChange } from "./i18n.js";
import { state } from "./state.js";
import { renderActivity } from "./activity.js";
import { initUpdate } from "./update.js";
import { applyStatusLabels } from "./status.js";
import { applyTheme, initSettings, renderSettings } from "./settings.js";
import { runCommand } from "./commands.js";
import { initLibraryApp } from "./library.js";

async function init() {
	const stored = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
	setConfig(stored);
	applyTheme();
	applyStaticTranslations();
	onLanguageChange(() => applyStaticTranslations());
	initSidebarResize();

	// converts the icons already in index.html (lucide.min.js loads before this module script
	// runs, so this only needs to happen once, this early) — without it they stay invisible
	// until something else happens to call refreshIcons() later, e.g. opening Settings
	refreshIcons();

	const status = await fetch("/api/status").then((r) => r.json());
	applyStatusLabels(status);
	renderActivity();
	initSettings();

	await initLibraryApp();

	if (status.features?.updates) initUpdate(); // background — shows the header Update button when something newer is published
}
init();

const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 480;

/** Drag #sidebar-resizer to resize the library sidebar; the width persists across restarts. */
function initSidebarResize() {
	const sidebar = $("sidebar");
	if (config.sidebarWidth) sidebar.style.width = `${config.sidebarWidth}px`;
	const handle = $("sidebar-resizer");
	handle.onmousedown = (event) => {
		const startX = event.clientX;
		const startWidth = sidebar.getBoundingClientRect().width;
		handle.classList.add("resizing");
		startDrag(event, {
			cursor: "col-resize",
			onMove: (e) => {
				const width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + (e.clientX - startX)));
				sidebar.style.width = `${width}px`;
			},
			onEnd: () => {
				handle.classList.remove("resizing");
				config.sidebarWidth = Math.round(sidebar.getBoundingClientRect().width);
				saveConfig();
			},
		});
	};
}

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
	"n": "new-library",
	"a": "toggle-activity",
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
