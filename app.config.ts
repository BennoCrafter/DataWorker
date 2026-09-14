/**
 * Central app configuration — the ONE file to edit when starting a new app from this template.
 *
 * Identity (id, name, bundle id) feeds the window title, the macOS/Linux packaging, the data /
 * cache / config directory names and the published artifact names. The `features` block turns
 * the optional subsystems on and off — every feature is a self-contained module that is only
 * loaded (dynamic import) and only routed when its flag is on:
 *
 *   macMenu      native macOS menu bar (macos-menu.ts) — also what makes Cmd+A/C/V/X/Z work
 *                in the webview's text fields on macOS. Without it the app still runs, but
 *                macOS users lose those shortcuts.
 *   windowsMenu  native Windows menu bar (windows-menu.ts). Purely additive chrome — unlike
 *                macOS, WebView2 handles the editing shortcuts by itself, so leaving this off
 *                just means a chromeless window.
 *   java         a Java runtime for the app's Java-backed work (server/java.ts): the FAT build
 *                variant embeds a thinned JRE (prep/jre.zip via `deno task build:fat`), the
 *                SLIM variant resolves a system JDK >= java.required.
 *   keychain     secrets via the denkbares keychain (~/.des-kch) read by a small Java helper
 *                (server/keychain.ts + helper/KeychainTool.java + jars/keychain-cli.jar), with
 *                the unlock password from DES_KEYCHAIN_PW or — on macOS — the login Keychain.
 *                REQUIRES `java`.
 *   components   big variable assets downloaded on first launch instead of shipped
 *                (server/components.ts) — register yours in its COMPONENTS list. Downloads can
 *                authenticate via env vars and (when on) the keychain.
 *   updates      in-app self-update (server/update.ts): `deno task publish` uploads the app +
 *                a manifest under fixed names; installed apps compare, download, verify and
 *                swap on disk — the restart is always an explicit user click.
 *   prerequisites  a startup gate (server/prereqs.ts + ui/js/prereqs.js): before the app UI
 *                boots, every prerequisite registered in server/prereqs.ts is checked; a
 *                blocking screen lists whatever is missing with an install hint per item and
 *                re-checks (button + auto-poll) until everything passes. Escape hatch:
 *                <envPrefix>_SKIP_PREREQS=1.
 *
 * Dependencies between features are validated at startup (validateFeatures): keychain needs
 * java; components/updates want repo.updateBase (or its env override) to point somewhere real.
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
		java: boolean;
		keychain: boolean;
		components: boolean;
		updates: boolean;
		prerequisites: boolean;
	};
	java: {
		/** Minimum Java major version for the slim variant's system JDK. */
		required: number;
		/** The fixed Temurin release `deno task build:jre` embeds into the fat variant. */
		jdkRelease: string;
		/** Locales kept in the thinned embedded runtime (jlink --include-locales). */
		jreLocales: string;
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
	id: "bento",
	name: "Bento",
	macBundleId: "com.local.bento",
	envPrefix: "BENTO",
	window: { width: 1100, height: 760 },
	features: {
		macMenu: true,
		windowsMenu: true,
		java: false,
		keychain: false,
		components: false,
		updates: false,
		prerequisites: false,
	},
	java: {
		required: 25,
		jdkRelease: "jdk-25.0.3+9",
		jreLocales: "en,de",
	},
	repo: {
		updateBase: "https://repo.example.com/artifactory/artifacts/my-app",
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
 * Cross-feature consistency warnings, logged once at server start. Deliberately warnings, not
 * errors — a half-configured app should still come up so Settings can say what is missing.
 */
export function validateFeatures(): string[] {
	const warnings: string[] = [];
	const { features } = APP;
	if (features.keychain && !features.java) {
		warnings.push(
			"features.keychain requires features.java (the keychain helper is a Java tool) — keychain is ignored",
		);
	}
	if ((features.components || features.updates) && APP.repo.updateBase.includes("example.com")) {
		warnings.push(
			`repo.updateBase still points at the placeholder (${APP.repo.updateBase}) — ` +
				"component downloads / update checks will fail until it is configured",
		);
	}
	return warnings;
}

/** The keychain feature, with its java dependency enforced. */
export function keychainEnabled(): boolean {
	return APP.features.keychain && APP.features.java;
}
