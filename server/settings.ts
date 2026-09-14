/**
 * The Settings popover's backend: a status snapshot (/api/settings) — version, platform, and
 * whatever the update check reports.
 */

import { APP, updateBase, validateFeatures } from "../app.config.ts";
import { json } from "./http.ts";
import { platformId } from "./paths.ts";
import { currentVersion } from "./version.ts";

export async function handleSettingsGet(): Promise<Response> {
	const version = await currentVersion();
	const snapshot: Record<string, unknown> = {
		ok: true,
		name: APP.name,
		features: APP.features,
		warnings: validateFeatures(),
		version: version?.version ?? null,
		commit: version?.commit ?? null,
		platform: platformId(),
		updateBase: updateBase(),
	};

	return json(snapshot);
}
