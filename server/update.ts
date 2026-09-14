/**
 * OPTIONAL FEATURE (features.updates): in-app updates — the app itself plus the downloaded
 * components (components.ts, when that feature is on), all behind the Update button, never
 * automatic. `deno task publish` uploads the platform app and a small manifest to the
 * repository under fixed names (always overwritten — no version history); this module compares
 * the baked-in version.json and the installed components against those manifests, downloads
 * what is newer with progress, verifies checksums and swaps the installed app in place. The
 * swapped app keeps running as the OLD build until the user opts into the restart
 * (requestRestart) — never automatically.
 *
 * On macOS the swapped-in .app stays Gatekeeper-trusted with no re-notarization: the notary
 * ticket is stapled INSIDE the bundle (scripts/notarize.sh), so it survives the publish zip →
 * download → unzip → whole-app swap, and `deno task publish` refuses an un-stapled app.
 */

import { APP, updateBase } from "../app.config.ts";
import { platformId } from "./paths.ts";
import { type BuildVersion, currentVersion } from "./version.ts";
import type { Progress } from "./http.ts";
import { downloadFile, fetchText, fileSha256 } from "./repo.ts";
import type { ComponentUpdate } from "./components.ts";

export type Manifest = { version: string; commit?: string | null; file: string; size?: number; sha256?: string };

/**
 * With the java feature on the app ships in two variants: fat (embedded JRE, artifact names
 * suffixed "-fat") and slim (system JDK, unsuffixed). Each installed app polls the manifest of
 * ITS OWN variant — fat updates to fat, slim to slim. Without the java feature there is only
 * one (unsuffixed) variant.
 */
export type Variant = "fat" | "slim";

/** Which variant THIS build is — detected by the presence of the embedded JRE. */
export async function clientVariant(): Promise<Variant> {
	if (!APP.features.java) return "slim";
	const { embeddedJre } = await import("./java.ts");
	return await embeddedJre() ? "fat" : "slim";
}

const variantSuffix = (variant: Variant) => variant === "fat" ? "-fat" : "";

/** Name of the published app artifact for this platform and variant. */
export function artifactName(variant: Variant): string {
	const extension = Deno.build.os === "darwin" ? "app.zip" : Deno.build.os === "linux" ? "AppImage" : "zip";
	return `${APP.id}-${platformId()}${variantSuffix(variant)}.${extension}`;
}

/** Name of the published update manifest for this platform and variant. */
export function manifestName(variant: Variant): string {
	return `manifest-${platformId()}${variantSuffix(variant)}.json`;
}

/** Compares the local build against the published manifest (latest is null when unreachable). */
async function checkAppUpdate(): Promise<
	{ current: BuildVersion | null; latest: Manifest | null; available: boolean; error?: string }
> {
	const current = await currentVersion();
	const manifestFile = manifestName(await clientVariant());
	let latest: Manifest | null = null;
	let error: string | undefined;
	try {
		const manifest = JSON.parse((await fetchText(`${updateBase()}/${manifestFile}`)).text);
		if (typeof manifest?.version === "string" && typeof manifest?.file === "string") latest = manifest;
		else error = `no usable manifest at ${updateBase()}/${manifestFile}`;
	} catch (cause) {
		// unreachable or not authenticated — the background check at boot just shows no offer,
		// the manual check in Settings surfaces this message. A plain 404 is not a failure:
		// it only means nothing has been published for this platform yet.
		const message = cause instanceof Error ? cause.message : String(cause);
		if (!message.includes("HTTP 404")) error = message;
	}
	// build versions are ISO timestamps — string order is chronological order. A same-commit
	// republish is NOT an update: the version is only the build date, so rebuilding identical
	// source would otherwise fan the full app out to every client for nothing. (Deliberate
	// same-commit rebuilds — e.g. a newer embedded JRE — need a commit to be offered.)
	const sameCommit = current?.commit != null && latest?.commit === current.commit;
	const available = current !== null && latest !== null && !sameCommit && latest.version > current.version;
	return { current, latest, available, error };
}

/** Component updates when that feature is on (lazy import), else an empty list. */
async function componentUpdates(): Promise<ComponentUpdate[]> {
	if (!APP.features.components) return [];
	const { checkComponentUpdates } = await import("./components.ts");
	return checkComponentUpdates();
}

/** An installed app update waiting for the user to restart into it. */
let pendingRestart: { target: Target; version: string } | null = null;

/** The full update picture: the app and every component, plus whether anything is newer. */
export async function checkForUpdate(): Promise<{
	app: { current: BuildVersion | null; latest: Manifest | null; available: boolean; error?: string };
	components: ComponentUpdate[];
	available: boolean;
	pendingRestart: string | null;
}> {
	const [app, components] = await Promise.all([checkAppUpdate(), componentUpdates()]);
	return {
		app,
		components,
		available: app.available || components.some((component) => component.available),
		pendingRestart: pendingRestart?.version ?? null,
	};
}

/**
 * Installs everything checkForUpdate() reports as newer: components first, then the app —
 * downloading the published build, verifying it and swapping the installed app in place.
 * Supported app layouts: the macOS .app bundle, a bare macOS binary, and the Linux AppImage.
 * NOTHING restarts here: an installed app update is reported as `restartRequired` and waits
 * for requestRestart(); component updates take effect in place.
 */
export async function applyUpdate(emit: Progress): Promise<Record<string, unknown>> {
	const { app, components } = await checkForUpdate();
	const outdated = components.filter((component) => component.available).map((component) => component.name);

	// the newest build is already installed and only waits for the restart
	const alreadyInstalled = pendingRestart !== null && pendingRestart.version === app.latest?.version;
	if (!app.available && outdated.length === 0) {
		if (alreadyInstalled) {
			emit(1, "Update installed — restart to finish");
			return { ok: true, restartRequired: true, version: pendingRestart?.version, updated: [] };
		}
		throw new Error("already up to date");
	}

	let updated: string[] = [];
	const appInstall = app.available && !alreadyInstalled;
	if (outdated.length > 0) {
		const { updateComponents } = await import("./components.ts");
		const componentEmit: Progress = appInstall
			? (pct, message) => emit(pct === null ? null : pct * 0.3, message)
			: emit;
		updated = await updateComponents(componentEmit, outdated);
	}
	if (!appInstall) {
		if (alreadyInstalled) {
			emit(1, "Updates installed — restart to finish");
			return { ok: true, restartRequired: true, version: pendingRestart?.version, updated };
		}
		emit(1, "Components updated");
		return { ok: true, restartRequired: false, updated };
	}

	const appEmit: Progress = outdated.length > 0
		? (pct, message) => emit(pct === null ? null : 0.3 + pct * 0.7, message)
		: emit;
	const latest = app.latest as Manifest;
	const target = updateTarget();
	const staging = `${stagingParent(target)}/.${APP.id}-update-${crypto.randomUUID().slice(0, 8)}`;
	await Deno.mkdir(staging, { recursive: true });
	try {
		const download = `${staging}/${latest.file}`;
		appEmit(0, "Downloading…");
		await downloadFile(`${updateBase()}/${latest.file}`, download, (received, total) => {
			const size = total ?? latest.size ?? null;
			appEmit(
				size ? (received / size) * 0.9 : null,
				`Downloading… ${megabytes(received)}${size ? ` / ${megabytes(size)}` : ""}`,
			);
		});

		if (latest.sha256) {
			appEmit(0.92, "Verifying…");
			const sha256 = await fileSha256(download);
			if (sha256 !== latest.sha256) throw new Error("checksum mismatch — the downloaded update is corrupt");
		}

		appEmit(0.96, "Installing…");
		await install(target, download, staging);
	} catch (error) {
		await Deno.remove(staging, { recursive: true }).catch(() => {});
		throw error;
	}
	await Deno.remove(staging, { recursive: true }).catch(() => {});

	// the new build is in place on disk; this instance keeps running until the user restarts
	pendingRestart = { target, version: latest.version };
	emit(1, "Update installed — restart to finish");
	return { ok: true, restartRequired: true, version: latest.version, updated };
}

/**
 * Quits this instance and starts the swapped-in app — only ever called on the user's explicit
 * request. The webview's native run loop blocks the main thread, so a polite in-process
 * shutdown is not possible: a detached watcher waits for this process to die and then launches
 * the new app, and the process is killed via a signal to itself (which takes the window along).
 */
export function requestRestart(): { ok: true; version: string | null } {
	const target = pendingRestart?.target ?? updateTarget();
	const path = target.kind === "mac-app" ? target.app : target.kind === "mac-binary" ? target.binary : target.path;
	const launch = target.kind === "mac-app" ? `open -n "$RESTART_TARGET"` : `exec "$RESTART_TARGET"`;
	const watcher = new Deno.Command("sh", {
		args: ["-c", `while kill -0 ${Deno.pid} 2>/dev/null; do sleep 0.2; done; ${launch}`],
		env: { RESTART_TARGET: path },
		stdin: "null",
		stdout: "null",
		stderr: "null",
	}).spawn();
	watcher.unref();
	// give the HTTP response a moment to flush, then die — Deno.exit() from this worker does
	// not stop the blocked webview main thread, a signal to our own pid does
	setTimeout(() => {
		try {
			Deno.kill(Deno.pid, "SIGTERM");
		} catch {
			// fall through to the hard exit below
		}
		setTimeout(() => Deno.exit(0), 1000);
	}, 300);
	return { ok: true, version: pendingRestart?.version ?? null };
}

type Target =
	| { kind: "mac-app"; app: string }
	| { kind: "mac-binary"; binary: string }
	| { kind: "appimage"; path: string };

function updateTarget(): Target {
	const exec = Deno.execPath();
	const execName = exec.split(/[/\\]/).pop() ?? "";
	if (execName === "deno" || execName === "deno.exe") {
		throw new Error("running from source — use git pull + deno task build instead");
	}
	if (Deno.build.os === "darwin") {
		// Gatekeeper's App Translocation runs a quarantined, never-moved .app from a read-only
		// randomized mount under /private/var/folders/.../AppTranslocation/. Deno.execPath() then
		// points into that copy, whose parent is read-only, so every swap below fails with EROFS
		// (os error 30). There is no self-update from there — the fix is the user moving the app
		// in Finder, which clears the com.apple.quarantine flag that triggers translocation.
		if (exec.includes("/AppTranslocation/")) {
			const appName = exec.match(/\/([^/]+\.app)\//)?.[1] ?? "the app";
			throw new Error(
				`${appName} is running from a temporary read-only location (macOS App Translocation), so it ` +
					`can't update itself. Move ${appName} to your Applications folder in Finder, reopen it from ` +
					`there, and run the update again.`,
			);
		}
		const app = exec.indexOf(".app/Contents/");
		if (app !== -1) return { kind: "mac-app", app: exec.slice(0, app + 4) };
		return { kind: "mac-binary", binary: exec };
	}
	if (Deno.build.os === "linux") {
		const appimage = Deno.env.get("APPIMAGE");
		if (appimage) return { kind: "appimage", path: appimage };
		throw new Error(`self-update needs the AppImage — download manually from ${updateBase()}`);
	}
	throw new Error(`self-update is not supported on ${Deno.build.os}`);
}

/** Staging lives next to the file being replaced, so the final rename stays on one volume. */
function stagingParent(target: Target): string {
	const path = target.kind === "mac-app" ? target.app : target.kind === "mac-binary" ? target.binary : target.path;
	return dirname(path);
}

async function install(target: Target, download: string, staging: string): Promise<void> {
	if (target.kind === "appimage") {
		await Deno.chmod(download, 0o755);
		await Deno.rename(download, target.path);
		return;
	}

	// macOS: the artifact is the zipped .app — extract it, then swap what this instance is
	const unzip = await new Deno.Command("unzip", { args: ["-q", download, "-d", staging] }).output();
	if (!unzip.success) throw new Error(`could not extract the update: ${new TextDecoder().decode(unzip.stderr).trim()}`);
	let newApp: string | null = null;
	for await (const entry of Deno.readDir(staging)) {
		if (entry.isDirectory && entry.name.endsWith(".app")) newApp = `${staging}/${entry.name}`;
	}
	if (!newApp) throw new Error("the update artifact holds no .app bundle");

	if (target.kind === "mac-app") {
		// move the running app aside, the new one in — deleting the old files is safe, the
		// running binary's inode stays alive until exit
		await Deno.rename(target.app, `${staging}/previous.app`);
		await Deno.rename(newApp, target.app);
	} else {
		// the in-bundle binary is named after the app (see scripts/make-app.sh)
		const binary = `${newApp}/Contents/Resources/${APP.name}`;
		await Deno.stat(binary);
		const temp = `${target.binary}.update`;
		await Deno.copyFile(binary, temp);
		await Deno.chmod(temp, 0o755);
		await Deno.rename(temp, target.binary);
	}
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dirname(path: string): string {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "/" : path.slice(0, index);
}
