/**
 * Filesystem and path helpers shared by the server modules: repo root, safe relative paths,
 * and the per-OS cache / data / config directories (named after APP.id).
 */
import { fromFileUrl } from "@std/path";
import { APP, appEnv } from "../app.config.ts";

/** Repo root (the directory holding server.ts, ui/, jars/, …). */
// fromFileUrl so a checkout path with spaces resolves (URL.pathname would keep %20)
export const ROOT = fromFileUrl(new URL("..", import.meta.url));

export function expandHome(path: string): string {
	const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
	return path === "~" ? home : path.startsWith("~/") ? home + path.slice(1) : path;
}

/** Rejects absolute paths and `.`/`..` segments; returns clean relative segments. */
export function sanitizeRelativePath(path: string): string[] {
	const segments = path.replaceAll("\\", "/").split("/").filter((s) => s.length > 0);
	if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
		throw new Error(`unsafe relative path: ${path}`);
	}
	return segments;
}

export function dirName(path: string): string {
	return path.split("/").slice(0, -1).join("/");
}

export async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await Deno.stat(path)).isDirectory;
	} catch {
		return false;
	}
}

/** Per-OS cache directory (extracted runtimes and other rebuildable state). */
export function cacheDir(): string {
	const home = Deno.env.get("HOME") ?? "";
	return Deno.build.os === "darwin"
		? `${home}/Library/Caches/${APP.id}`
		: Deno.build.os === "windows"
		? `${Deno.env.get("LOCALAPPDATA") ?? home}/${APP.id}/cache`
		: `${Deno.env.get("XDG_CACHE_HOME") ?? `${home}/.cache`}/${APP.id}`;
}

/** Per-OS data directory (downloaded components live under here). */
export function dataDir(): string {
	const custom = appEnv("DATA_DIR");
	if (custom) return expandHome(custom);
	const home = Deno.env.get("HOME") ?? "";
	return Deno.build.os === "darwin"
		? `${home}/Library/Application Support/${APP.id}`
		: Deno.build.os === "windows"
		? `${Deno.env.get("APPDATA") ?? home}/${APP.id}`
		: `${Deno.env.get("XDG_DATA_HOME") ?? `${home}/.local/share`}/${APP.id}`;
}

/** Per-OS config directory (the persisted user config, see server/system.ts). */
export function configDir(): string {
	const home = Deno.env.get("HOME") ?? "";
	return Deno.build.os === "darwin"
		? `${home}/Library/Application Support/${APP.id}`
		: Deno.build.os === "windows"
		? `${Deno.env.get("APPDATA") ?? home}/${APP.id}`
		: `${Deno.env.get("XDG_CONFIG_HOME") ?? `${home}/.config`}/${APP.id}`;
}

/**
 * Where downloaded components live. The layout (<file> + <name>-info.json, <name>/<stamp> for
 * extracted archives) is owned by server/components.ts; other modules may read installed files
 * from here directly to avoid importing the download stack.
 */
export function componentsDir(): string {
	return `${dataDir()}/components`;
}

/** Platform id used in published artifact names, e.g. "mac-aarch64" or "linux-x86_64". */
export function platformId(): string {
	return `${Deno.build.os === "darwin" ? "mac" : Deno.build.os}-${Deno.build.arch}`;
}
