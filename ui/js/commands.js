/**
 * The command registry — one table behind the keyboard shortcuts (main.js) and the native
 * macOS menu (macos-menu.ts forwards its items here via globalThis.__nativeMenu). Menu items
 * and shortcuts always do the same thing because both dispatch through runCommand().
 *
 * ADD YOUR APP'S COMMANDS here and wire them into macos-menu.ts / the shortcut tables.
 */
import { state } from "./state.js";
import { renderActivity } from "./activity.js";
import { closeSettings, openSettings, setTheme } from "./settings.js";
import { appStatus } from "./status.js";
import { applyUpdates, fetchUpdateCheck, showUpdateButton } from "./update.js";
import { importCsvCommand, newLibraryCommand, newRecordCommand } from "./library.js";

const COMMANDS = {
	"settings": () => state.showSettings ? closeSettings() : openSettings(),
	"about": () => openSettings(),
	"help": () => openSettings(),
	"theme-light": () => setTheme("light"),
	"theme-dark": () => setTheme("dark"),
	"toggle-activity": () => {
		state.showActivity = !state.showActivity;
		renderActivity();
	},
	"check-updates": async () => {
		if (!appStatus.features?.updates) return;
		const check = await fetchUpdateCheck();
		if (check?.available) {
			showUpdateButton(check);
			applyUpdates();
		} else {
			openSettings(); // the settings App section reports "up to date" / errors
		}
	},
	"new-library": () => newLibraryCommand(),
	"new-record": () => newRecordCommand(),
	"import-csv": () => importCsvCommand(),
};

export function runCommand(command) {
	const cmd = typeof command === "string" ? command : command?.cmd;
	COMMANDS[cmd]?.(command);
}
