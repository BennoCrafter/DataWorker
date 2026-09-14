/**
 * OS and app-level integration (always on): native file/folder/save dialogs, reveal-in-file-
 * manager (limited to outputs produced this session), opening external links in the user's
 * browser (limited to links the app registered), and the persisted user config.
 */

import { json } from "./http.ts";
import { configDir, dirName } from "./paths.ts";

/**
 * Shows a native chooser and returns the picked path, or null if cancelled. In file mode,
 * `types` restricts the selectable extensions.
 */
export async function pickNative(prompt: string, folder: boolean, types?: string[]): Promise<string | null> {
	const typeClause = !folder && types?.length ? ` of type {${types.map((t) => `"${t}"`).join(", ")}}` : "";
	const command = Deno.build.os === "darwin"
		? new Deno.Command("osascript", {
			args: ["-e", `POSIX path of (choose ${folder ? "folder" : "file"} with prompt "${prompt}"${typeClause})`],
			stdout: "piped",
			stderr: "piped",
		})
		: Deno.build.os === "linux"
		? new Deno.Command("zenity", {
			args: [
				"--file-selection",
				...(folder ? ["--directory"] : []),
				...(!folder && types?.length ? ["--file-filter", `Files | ${types.map((t) => "*." + t).join(" ")}`] : []),
				"--title",
				prompt,
			],
			stdout: "piped",
			stderr: "piped",
		})
		: null;
	if (!command) return null;
	const result = await command.output();
	if (!result.success) return null; // cancelled (or chooser unavailable)
	const path = new TextDecoder().decode(result.stdout).trim().replace(/\/$/, "");
	return path || null;
}

/** Native save dialog (choose a destination path for a new file), or null if cancelled. */
export async function pickSaveFile(prompt: string, defaultName: string): Promise<string | null> {
	const command = Deno.build.os === "darwin"
		? new Deno.Command("osascript", {
			args: ["-e", `POSIX path of (choose file name with prompt "${prompt}" default name "${defaultName}")`],
			stdout: "piped",
			stderr: "piped",
		})
		: Deno.build.os === "linux"
		? new Deno.Command("zenity", {
			args: ["--file-selection", "--save", "--confirm-overwrite", "--filename", defaultName, "--title", prompt],
			stdout: "piped",
			stderr: "piped",
		})
		: null;
	if (!command) return null;
	const result = await command.output();
	if (!result.success) return null;
	const path = new TextDecoder().decode(result.stdout).trim().replace(/\/$/, "");
	return path || null;
}

export async function handlePickFolder(): Promise<Response> {
	const path = await pickNative("Choose a folder", true);
	return path ? json({ ok: true, path }) : json({ ok: false, cancelled: true });
}

/** Native open-file dialog; POST body may carry {prompt, types: ["ext", …]}. */
export async function handlePickFile(request: Request): Promise<Response> {
	const body = await request.json().catch(() => ({}));
	const types = Array.isArray(body?.types) ? body.types.map(String) : undefined;
	const path = await pickNative(String(body?.prompt ?? "Choose a file"), false, types);
	return path ? json({ ok: true, path, name: path.split("/").pop() }) : json({ ok: false, cancelled: true });
}

// ---------------------------------------------------------------------------
// reveal in file manager
// ---------------------------------------------------------------------------

/**
 * Outputs produced this session — the only paths /api/reveal will open. Add every file your
 * app writes on the user's behalf, then the UI can offer a "Reveal" button for it.
 */
export const producedOutputs = new Set<string>();

export async function handleReveal(request: Request): Promise<Response> {
	const { path } = await request.json();
	if (typeof path !== "string" || !producedOutputs.has(path)) {
		return json({ ok: false, error: "unknown path" }, 400);
	}
	const command = Deno.build.os === "darwin"
		? new Deno.Command("open", { args: ["-R", path] })
		: Deno.build.os === "windows"
		? new Deno.Command("explorer", { args: [`/select,${path.replaceAll("/", "\\")}`] })
		: new Deno.Command("xdg-open", { args: [dirName(path) || "/"] });
	await command.output();
	return json({ ok: true });
}

/**
 * URLs the app may open in the user's browser — the only ones /api/open-url accepts. Register
 * every link your UI offers (mirrors producedOutputs for files): the page must not be able to
 * make the app launch arbitrary URLs.
 */
export const externalLinks = new Set<string>();

/** Opens a registered link in the system browser — a webview must never navigate there itself. */
export async function handleOpenUrl(request: Request): Promise<Response> {
	const { url } = await request.json();
	if (typeof url !== "string" || !externalLinks.has(url)) return json({ ok: false, error: "unknown url" }, 400);
	const opener = Deno.build.os === "darwin" ? "open" : Deno.build.os === "windows" ? "explorer" : "xdg-open";
	await new Deno.Command(opener, { args: [url] }).output();
	return json({ ok: true });
}

// ---------------------------------------------------------------------------
// user config (theme, preferences, recents, …) — persisted in the OS config dir
// ---------------------------------------------------------------------------

function configFile(): string {
	return `${configDir()}/config.json`;
}

export async function handleConfigGet(): Promise<Response> {
	try {
		return json(JSON.parse(await Deno.readTextFile(configFile())));
	} catch {
		return json({});
	}
}

export async function handleConfigSave(request: Request): Promise<Response> {
	const config = await request.json();
	if (config === null || typeof config !== "object") return json({ ok: false, error: "no config object" }, 400);
	const file = configFile();
	await Deno.mkdir(dirName(file), { recursive: true });
	await Deno.writeTextFile(file, JSON.stringify(config, null, "\t") + "\n");
	return json({ ok: true });
}
