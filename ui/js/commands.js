/**
 * The command registry — one table behind the keyboard shortcuts (main.js) and the native
 * macOS menu (macos-menu.ts forwards its items here via globalThis.__nativeMenu). Menu items
 * and shortcuts always do the same thing because both dispatch through runCommand().
 *
 * ADD YOUR APP'S COMMANDS here and wire them into macos-menu.ts / the shortcut tables.
 */
import { state } from "./state.js";
import { closeSettings, openSettings, setTheme } from "./settings.js";
import { importCsvCommand, newLibraryCommand, newRecordCommand } from "./library.js";

const COMMANDS = {
	"settings": () => state.showSettings ? closeSettings() : openSettings(),
	"about": () => openSettings(),
	"help": () => openSettings(),
	"theme-light": () => setTheme("light"),
	"theme-dark": () => setTheme("dark"),
	"new-library": () => newLibraryCommand(),
	"new-record": () => newRecordCommand(),
	"import-csv": () => importCsvCommand(),
};

export function runCommand(command) {
	const cmd = typeof command === "string" ? command : command?.cmd;
	COMMANDS[cmd]?.(command);
}
