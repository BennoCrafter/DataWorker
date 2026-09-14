/**
 * Central app configuration.
 *
 * Identity (id, name, bundle id) feeds the window title, the macOS/Linux packaging, the data /
 * cache / config directory names and the published artifact names. The `features` block turns
 * the optional subsystems on and off — each is a self-contained module that is only loaded
 * (dynamic import) and only routed when its flag is on:
 *
 *   macMenu      native macOS menu bar (macos-menu.ts) — also what makes Cmd+A/C/V/X/Z work
 *                in the webview's text fields on macOS. Without it the app still runs, but
 *                macOS users lose those shortcuts.
 *   windowsMenu  native Windows menu bar (windows-menu.ts). Purely additive chrome — unlike
 *                macOS, WebView2 handles the editing shortcuts by itself, so leaving this off
 *                just means a chromeless window.
 *   updates      in-app self-update (server/update.ts): `deno task publish` uploads the app +
 *                a manifest under fixed names; installed apps compare, download, verify and
 *                swap on disk — the restart is always an explicit user click.
 */

export interface AppConfig {
	/** kebab-case machine id: directory names, artifact names, WM_CLASS, binary name. */
	id: string;
	/** Human name: window title, macOS menu/app name, .desktop entry. */
	name: string;
	/** macOS bundle identifier for the packaged .app. */
	macBundleId: string;
	/** Prefix for the app's environment variables, e.g. "MY_APP" → MY_APP_PORT, MY_APP_DATA_DIR, … */
	envPrefix: string;
	window: { width: number; height: number };
	features: {
		macMenu: boolean;
		windowsMenu: boolean;
		updates: boolean;
	};
	repo: {
		/**
		 * Repository folder (e.g. Artifactory) holding the published app + update manifests.
		 * Used by the updates feature and `deno task publish`; override at runtime with
		 * <envPrefix>_UPDATE_URL.
		 */
		updateBase: string;
	};
}

export const APP: AppConfig = {
	id: "dataworker",
	name: "DataWorker",
	macBundleId: "com.local.dataworker",
	envPrefix: "DATAWORKER",
	window: { width: 1100, height: 760 },
	features: {
		macMenu: true,
		windowsMenu: true,
		updates: true,
	},
	repo: {
		// a dedicated, force-pushed branch on the app's own GitHub repo — see scripts/publish.ts.
		// Plain GETs (server/update.ts) work anonymously against a public repo's raw file URLs;
		// no credentials/repo.ts auth chain needed for the download side.
		updateBase: "https://raw.githubusercontent.com/BennoCrafter/DataWorker/releases",
	},
};

/** An app-prefixed environment variable, e.g. appEnv("PORT") → $MY_APP_PORT. */
export function appEnv(suffix: string): string | undefined {
	return Deno.env.get(`${APP.envPrefix}_${suffix}`);
}

/** The update/publish repository folder — env override first, then the configured default. */
export function updateBase(): string {
	return appEnv("UPDATE_URL") ?? APP.repo.updateBase;
}

/**
 * Consistency warning, logged once at server start. Deliberately a warning, not an error — a
 * half-configured app should still come up so Settings can say what is missing.
 */
export function validateFeatures(): string[] {
	const warnings: string[] = [];
	if (APP.features.updates && APP.repo.updateBase.includes("example.com")) {
		warnings.push(
			`repo.updateBase still points at the placeholder (${APP.repo.updateBase}) — ` +
				"update checks will fail until it is configured",
		);
	}
	return warnings;
}
