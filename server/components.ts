/**
 * OPTIONAL FEATURE (features.components): downloaded runtime components.
 *
 * The compiled app ships without its big variable assets — they are downloaded on first launch
 * into the data dir (see paths.componentsDir) and updated on demand from the Settings / Update
 * button, never automatically.
 *
 * REGISTER YOUR COMPONENTS in the COMPONENTS list below. Two ready-made factories cover the
 * common cases:
 *
 *   mavenLatestReleaseJar(…)   a jar resolved from Maven repository metadata — the newest
 *                              release version is looked up in maven-metadata.xml and the
 *                              versioned jar downloaded to a fixed local name.
 *   checksumVersionedZip(…)    an archive published under a FIXED url whose "version" is its
 *                              checksum (x-checksum-sha256/etag header) — downloaded and
 *                              extracted to <name>/<stamp>, previous extractions pruned.
 *
 * Layout in componentsDir(): <file> + <name>-info.json (jars), <name>/<stamp> +
 * <name>-info.json (extracted archives). Other modules may resolve installed files from that
 * layout directly (installedFile/installedDir) without importing the download stack.
 */

import { downloadFile, fetchAuthenticated, fetchText } from "./repo.ts";
import { componentsDir, isDirectory } from "./paths.ts";
import type { Progress } from "./http.ts";

export type ComponentUpdate = {
	name: string;
	label: string;
	installed: string | null;
	latest: string | null;
	available: boolean;
	error?: string;
};

// deno-lint-ignore no-explicit-any
type Info = any;

export type Component = {
	name: string;
	label: string;
	infoFile: string;
	/** Version of the installed component, or null when absent/broken. Local only. */
	installed(): Promise<string | null>;
	/** Latest published version, and whether a stored info matches it. Network. */
	remote(): Promise<{ version: string; upToDate(info: Info): boolean }>;
	/** Downloads and installs the latest version (unconditionally). */
	install(emit: Progress): Promise<void>;
};

/**
 * The app's components. EXAMPLES (delete/replace):
 *
 *   const COMPONENTS: Component[] = [
 *   	mavenLatestReleaseJar({
 *   		name: "cli",
 *   		label: "Example CLI",
 *   		base: "https://repo.example.com/artifactory/releases/com/example/example-cli",
 *   		classifier: "jar-with-dependencies",
 *   		file: "example-cli.jar",
 *   	}),
 *   	checksumVersionedZip({
 *   		name: "tools",
 *   		label: "Example tools",
 *   		url: "https://repo.example.com/artifactory/artifacts/example-tools-bin.zip",
 *   	}),
 *   ];
 */
const COMPONENTS: Component[] = [];

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

/** Installed versions per component (null = not installed). Local, no network. */
export async function installedComponents(): Promise<Record<string, string | null>> {
	const entries = await Promise.all(
		COMPONENTS.map(async (component) => [component.name, await component.installed()] as const),
	);
	return Object.fromEntries(entries);
}

/** True when every component is installed — the app is fully usable. */
export async function componentsReady(): Promise<boolean> {
	const components = await installedComponents();
	return Object.values(components).every((version) => version !== null);
}

/** The installed file of a jar-style component, or null (checks the info file + the file). */
export async function installedFile(name: string): Promise<string | null> {
	const info = await readInfo(`${name}-info.json`);
	if (typeof info?.file !== "string") return null;
	return await exists(info.file) ? info.file : null;
}

/** The extracted directory of a zip-style component, or null. */
export async function installedDir(name: string): Promise<{ dir: string; version: string } | null> {
	const info = await readInfo(`${name}-info.json`);
	if (typeof info?.dir !== "string" || typeof info?.version !== "string") return null;
	if (!await isDirectory(info.dir)) return null;
	return { dir: info.dir, version: info.version };
}

// ---------------------------------------------------------------------------
// install & update
// ---------------------------------------------------------------------------

/** Downloads every missing component (existing ones are left alone — updates are explicit). */
export function ensureComponents(emit: Progress): Promise<Record<string, unknown>> {
	return withLock(async () => {
		const missing: Component[] = [];
		for (const component of COMPONENTS) {
			if (await component.installed() === null) missing.push(component);
		}
		for (const [index, component] of missing.entries()) {
			await component.install(scale(emit, index / missing.length, (index + 1) / missing.length));
		}
		return { ok: true, installed: missing.map((component) => component.label) };
	});
}

/** Compares installed components against their sources. Network; per-component failures are reported. */
export async function checkComponentUpdates(): Promise<ComponentUpdate[]> {
	return await Promise.all(COMPONENTS.map(async (component) => {
		const installed = await component.installed();
		try {
			const [remote, info] = await Promise.all([component.remote(), readInfo(component.infoFile)]);
			return {
				name: component.name,
				label: component.label,
				installed,
				latest: remote.version,
				available: installed === null || !remote.upToDate(info),
			};
		} catch (error) {
			return {
				name: component.name,
				label: component.label,
				installed,
				latest: null,
				available: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}));
}

/** Downloads the latest version of the named components (used by the update flow). */
export function updateComponents(emit: Progress, names: string[]): Promise<string[]> {
	return withLock(async () => {
		const wanted = COMPONENTS.filter((component) => names.includes(component.name));
		for (const [index, component] of wanted.entries()) {
			await component.install(scale(emit, index / wanted.length, (index + 1) / wanted.length));
		}
		return wanted.map((component) => component.label);
	});
}

// ---------------------------------------------------------------------------
// factory: a jar resolved from Maven repository metadata (newest release version)
// ---------------------------------------------------------------------------

export function mavenLatestReleaseJar(spec: {
	name: string;
	label: string;
	/** Directory URL of the artifact, e.g. …/releases/com/example/example-cli */
	base: string;
	/** Optional classifier, e.g. "jar-with-dependencies". */
	classifier?: string;
	/** Fixed local file name inside componentsDir(). */
	file: string;
}): Component {
	const infoFile = `${spec.name}-info.json`;
	const artifactId = spec.base.replace(/\/+$/, "").split("/").pop() ?? spec.name;

	async function source(): Promise<{ version: string; url: string }> {
		const metadataUrl = `${spec.base}/maven-metadata.xml`;
		const version = latestReleaseVersion((await fetchText(metadataUrl)).text, metadataUrl);
		const classifier = spec.classifier ? `-${spec.classifier}` : "";
		return { version, url: `${spec.base}/${version}/${artifactId}-${version}${classifier}.jar` };
	}

	return {
		name: spec.name,
		label: spec.label,
		infoFile,
		async installed() {
			const info = await readInfo(infoFile);
			if (typeof info?.version !== "string") return null;
			if (!await exists(`${componentsDir()}/${spec.file}`)) return null;
			return `${artifactId} ${info.version}`;
		},
		async remote() {
			const remote = await source();
			return {
				version: `${artifactId} ${remote.version}`,
				upToDate: (info) => info?.version === remote.version,
			};
		},
		async install(emit) {
			const remote = await source();
			const target = `${componentsDir()}/${spec.file}`;
			await downloadFile(remote.url, target, downloadProgress(emit, 0, 1, spec.label));
			await writeInfo(infoFile, {
				version: remote.version,
				source: remote.url,
				file: target,
				stamp: Date.now(),
			});
		},
	};
}

/** The newest released version — the <release> tag, or <latest>/last <version> as fallbacks. */
function latestReleaseVersion(metadata: string, metadataUrl: string): string {
	const release = firstTag(metadata, "release") ?? firstTag(metadata, "latest");
	if (release) return release;

	const version = tags(metadata, "version").at(-1);
	if (!version) throw new Error(`No versions found in ${metadataUrl}`);
	return version;
}

function firstTag(xml: string, tag: string): string | null {
	return tags(xml, tag)[0] ?? null;
}

function tags(xml: string, tag: string): string[] {
	return [...xml.matchAll(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "g"))]
		.map((match) => decodeXml(match[1].trim()));
}

function decodeXml(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

// ---------------------------------------------------------------------------
// factory: an archive under a fixed URL, versioned by its checksum, extracted on install
// ---------------------------------------------------------------------------

export function checksumVersionedZip(spec: {
	name: string;
	label: string;
	/** The fixed artifact URL; each upload overwrites it in place. */
	url: string;
}): Component {
	const infoFile = `${spec.name}-info.json`;

	/** The artifact has a fixed URL — its version is its checksum, labeled by upload date. */
	async function source(): Promise<{ version: string; checksum: string | null }> {
		const { response } = await fetchAuthenticated(spec.url, { method: "HEAD" });
		await response.body?.cancel();
		const checksum = response.headers.get("x-checksum-sha256") ?? response.headers.get("etag");
		const modified = response.headers.get("last-modified");
		const date = modified ? new Date(modified).toISOString().slice(0, 10) : null;
		return { version: `${spec.name}${date ? ` (${date})` : ""}`, checksum };
	}

	return {
		name: spec.name,
		label: spec.label,
		infoFile,
		async installed() {
			return (await installedDir(spec.name))?.version ?? null;
		},
		async remote() {
			const remote = await source();
			return {
				version: remote.version,
				// no checksum header would mean "always update" — treat it as up to date instead
				upToDate: (info) => remote.checksum === null || info?.checksum === remote.checksum,
			};
		},
		async install(emit) {
			const remote = await source();
			const zip = `${componentsDir()}/${spec.name}-download.zip`;
			await downloadFile(spec.url, zip, downloadProgress(emit, 0, 0.8, spec.label));
			const stamp = Date.now();
			const dir = `${componentsDir()}/${spec.name}/${stamp}`;
			emit(0.85, `Extracting ${spec.label}…`);
			try {
				await extractZip(zip, dir);
			} finally {
				await Deno.remove(zip).catch(() => {});
			}
			await prune(`${componentsDir()}/${spec.name}`, `${stamp}`);
			await writeInfo(infoFile, {
				version: remote.version,
				source: spec.url,
				checksum: remote.checksum,
				stamp,
				dir,
			});
			emit(1, `${spec.label} installed`);
		},
	};
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Serializes installs — a boot-time ensure and a user-triggered update must not interleave. */
let lock: Promise<unknown> = Promise.resolve();

function withLock<T>(run: () => Promise<T>): Promise<T> {
	const chained = lock.then(run, run);
	lock = chained.catch(() => {});
	return chained;
}

/** Maps a component-local 0..1 progress into the [from, to] slice of the overall progress. */
function scale(emit: Progress, from: number, to: number): Progress {
	return (pct, message) => emit(pct === null ? null : from + pct * (to - from), message);
}

function downloadProgress(emit: Progress, from: number, to: number, label: string) {
	return (received: number, total: number | null) =>
		scale(emit, from, to)(
			total ? received / total : null,
			`Downloading ${label}… ${megabytes(received)}${total ? ` / ${megabytes(total)}` : ""}`,
		);
}

/** Unzips into a staging directory next to `target`, then renames it into place. */
async function extractZip(zip: string, target: string): Promise<void> {
	await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
	const staging = `${target}.partial-${crypto.randomUUID().slice(0, 8)}`;
	const result = await new Deno.Command("unzip", {
		args: ["-q", zip, "-d", staging],
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (!result.success) {
		await Deno.remove(staging, { recursive: true }).catch(() => {});
		throw new Error(`could not extract ${zip}: ${new TextDecoder().decode(result.stderr).trim()}`);
	}
	await Deno.remove(target, { recursive: true }).catch(() => {});
	await Deno.rename(staging, target);
}

/** Removes every entry in `base` except `keep` (older extractions and stale stagings). */
async function prune(base: string, keep: string): Promise<void> {
	try {
		for await (const entry of Deno.readDir(base)) {
			if (entry.name !== keep) await Deno.remove(`${base}/${entry.name}`, { recursive: true }).catch(() => {});
		}
	} catch {
		// base does not exist yet
	}
}

async function readInfo(name: string): Promise<Info> {
	try {
		return JSON.parse(await Deno.readTextFile(`${componentsDir()}/${name}`));
	} catch {
		return null;
	}
}

async function writeInfo(name: string, info: Record<string, unknown>): Promise<void> {
	await Deno.mkdir(componentsDir(), { recursive: true });
	await Deno.writeTextFile(`${componentsDir()}/${name}`, JSON.stringify(info) + "\n");
}

async function exists(path: string): Promise<boolean> {
	try {
		await Deno.stat(path);
		return true;
	} catch {
		return false;
	}
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
