/**
 * User preferences (theme, and whatever your app adds) — a plain object persisted via
 * /api/config into the OS config dir. Loaded once at boot (setConfig), mutated in place and
 * re-saved with saveConfig().
 */

export let config = {};
export const currentTheme = () => config.theme === "dark" ? "dark" : "light";

export function saveConfig() {
	fetch("/api/config", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(config),
	}).catch(() => {});
}

/** Replaces the whole config object (used once at boot with the server-stored config). */
export function setConfig(next) {
	config = next && typeof next === "object" ? next : {};
}
