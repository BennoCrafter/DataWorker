/**
 * The Settings popover's backend: a status snapshot (/api/settings) assembled from whichever
 * features are enabled, and — keychain feature, macOS — storing the keychain's unlock password.
 *
 * The app does NOT set repository credentials itself — with the keychain feature on they are
 * expected to already live in the keychain (put there with KeychainCLI or shared from another
 * tool); the app only reads them, and Settings just reports whether they are present.
 */

import { APP, keychainEnabled, updateBase, validateFeatures } from "../app.config.ts";
import { json } from "./http.ts";
import { platformId } from "./paths.ts";
import { currentVersion } from "./version.ts";

export async function handleSettingsGet(): Promise<Response> {
	const version = await currentVersion();
	const snapshot: Record<string, unknown> = {
		ok: true,
		name: APP.name,
		features: { ...APP.features, keychain: keychainEnabled() },
		warnings: validateFeatures(),
		version: version?.version ?? null,
		commit: version?.commit ?? null,
		platform: platformId(),
		updateBase: updateBase(),
	};

	if (APP.features.java) {
		const java = await import("./java.ts");
		const [versionLine, source, problem] = await Promise.all([
			java.javaVersion(),
			java.javaSource(),
			java.javaProblem(),
		]);
		snapshot.java = versionLine;
		snapshot.javaSource = source;
		snapshot.javaProblem = problem;
	}

	if (APP.features.components) {
		const components = await import("./components.ts");
		snapshot.components = await components.installedComponents();
		snapshot.componentsReady = await components.componentsReady();
	}

	if (keychainEnabled()) {
		const keychain = await import("./keychain.ts");
		snapshot.keychain = await keychain.keychainOverview(`${updateBase()}/`);
	}

	// where a repository download would authenticate from — relevant once anything downloads.
	// NOT shown for updates here: this app's updateBase is a public GitHub repo's raw file
	// URLs, which anonymous GETs already work against by design — showing the "no credentials
	// found" section for that would read as a problem when there deliberately isn't one. Add
	// features.updates back to this condition if updateBase ever moves somewhere that needs auth.
	if (APP.features.components) {
		const repo = await import("./repo.ts");
		snapshot.repo = await repo.credentialStatus(`${updateBase()}/`);
	}

	return json(snapshot);
}

/** Stores (empty clears) the keychain's unlock password in the macOS login Keychain. */
export async function handleKeychainPassword(request: Request): Promise<Response> {
	const { password } = await request.json();
	try {
		const { storeKeychainPassword } = await import("./keychain.ts");
		const keychain = await storeKeychainPassword(String(password ?? ""));
		return json({ ok: true, keychain });
	} catch (error) {
		return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
	}
}
