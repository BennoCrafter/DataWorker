/**
 * The build identity baked in by `deno task compile` (scripts/write-version.ts): an ISO UTC
 * build timestamp used as the version — string order is release order — plus the git commit.
 * Running from source without a build stamp yields null.
 */
import { ROOT } from "./paths.ts";

export type BuildVersion = { version: string; commit: string | null };

export async function currentVersion(): Promise<BuildVersion | null> {
	try {
		const info = JSON.parse(await Deno.readTextFile(`${ROOT}version.json`));
		if (typeof info?.version === "string") return { version: info.version, commit: info.commit ?? null };
	} catch {
		// no build stamp
	}
	return null;
}
