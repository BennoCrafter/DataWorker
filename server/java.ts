/**
 * OPTIONAL FEATURE (features.java): Java runtime integration.
 *
 * Locates a Java runtime, materializes embedded assets (helper sources, the keychain jar) out
 * of the compiled binary's virtual filesystem so external java processes can read them, and
 * offers helpers to run jars. The app ships in two variants:
 *
 *   FAT   embeds a thinned JRE (prep/jre.zip, baked in by `deno task build:fat`, extracted
 *         once into the user cache) — always has a matching runtime, no prerequisite.
 *   SLIM  ships no runtime and requires an installed JDK >= APP.java.required, resolved via
 *         JAVA_HOME → (macOS) /usr/libexec/java_home → PATH with each candidate's version
 *         validated — so a stale JAVA_HOME pointing at an older JDK does not shadow an
 *         installed matching one.
 *
 * javaProblem() reports a human-readable requirement violation for the status pill / Settings.
 * With the keychain feature on, a full JDK (javac) is required in the slim variant: the
 * keychain helper's source-launcher fallback compiles at run time.
 */

import { APP, keychainEnabled } from "../app.config.ts";
import { cacheDir, ROOT } from "./paths.ts";

const EMBEDDED_KEYCHAIN_JAR = `${ROOT}jars/keychain-cli.jar`;
const EMBEDDED_KEYCHAIN_HELPER = `${ROOT}helper/KeychainTool.java`;
const EMBEDDED_KEYCHAIN_CLASSES = `${ROOT}helper/classes`;
const EMBEDDED_JRE_ZIP = `${ROOT}prep/jre.zip`;
const EMBEDDED_JRE_INFO = `${ROOT}prep/jre-info.json`;

const REQUIRED_JAVA = APP.java.required;

/**
 * The java executable: the embedded runtime when this is a fat build (extracted once into the
 * user cache), else the first system candidate that SATISFIES the requirement. When no
 * candidate satisfies it, the first existing candidate is returned so javaProblem() can report
 * what was found. Memoized — concurrent callers share one extraction.
 */
let javaBinaryPromise: Promise<string> | undefined;

export function javaBinary(): Promise<string> {
	return javaBinaryPromise ??= resolveJavaBinary();
}

async function resolveJavaBinary(): Promise<string> {
	const embedded = await embeddedJre();
	if (embedded) {
		try {
			return await ensureEmbeddedJre(embedded);
		} catch (error) {
			console.error("embedded Java runtime unavailable, falling back:", error);
		}
	} else {
		// a slim build over a previous fat install: reclaim the extracted runtime quietly
		Deno.remove(`${cacheDir()}/jre`, { recursive: true }).catch(() => {});
	}

	const candidates: string[] = [];
	const home = Deno.env.get("JAVA_HOME");
	if (home) candidates.push(`${home}/bin/java`);
	// Finder-launched apps have no JAVA_HOME and a bare PATH — ask launch services for a
	// matching JDK (the /usr/bin/java stub would pick the system default, which may be older)
	if (Deno.build.os === "darwin") {
		try {
			const result = await new Deno.Command("/usr/libexec/java_home", {
				args: ["-v", `${REQUIRED_JAVA}+`],
				stdout: "piped",
				stderr: "null",
			}).output();
			const jdkHome = new TextDecoder().decode(result.stdout).trim();
			if (result.success && jdkHome) candidates.push(`${jdkHome}/bin/java`);
		} catch {
			// no java_home helper
		}
	}
	candidates.push("java");

	let fallback: string | null = null;
	for (const candidate of candidates) {
		const version = await versionLineOf(candidate);
		if (version === null) continue; // missing or not runnable
		const major = javaMajor(version);
		if (major !== null && major >= REQUIRED_JAVA) return candidate;
		fallback ??= candidate;
	}
	return fallback ?? "java";
}

/** The first `java -version` line of a binary, or null when it is missing/not runnable. */
async function versionLineOf(java: string): Promise<string | null> {
	try {
		const result = await new Deno.Command(java, { args: ["-version"], stdout: "piped", stderr: "piped" }).output();
		if (!result.success) return null;
		// `java -version` prints to stderr
		const line = new TextDecoder().decode(result.stderr).split("\n")[0]?.trim();
		return line || "java";
	} catch {
		return null;
	}
}

/** The Java runtime embedded by `deno task build:fat` (absent in slim builds and source runs; platform must match). */
export async function embeddedJre(): Promise<{ version: string; stamp: number } | null> {
	try {
		const info = JSON.parse(await Deno.readTextFile(EMBEDDED_JRE_INFO));
		await Deno.stat(EMBEDDED_JRE_ZIP);
		if (info?.os !== Deno.build.os || info?.arch !== Deno.build.arch) return null;
		if (typeof info?.version === "string" && typeof info?.stamp === "number") return info;
	} catch {
		// slim build or source run
	}
	return null;
}

/** Extracts the embedded runtime into the cache (once per build) and returns its java path. */
async function ensureEmbeddedJre(info: { version: string; stamp: number }): Promise<string> {
	const base = `${cacheDir()}/jre`;
	const target = `${base}/${info.stamp}`;
	const java = `${target}/bin/java`;
	try {
		await Deno.stat(java);
		return java;
	} catch {
		// not extracted yet
	}
	await Deno.mkdir(base, { recursive: true });
	// drop runtimes of older builds, then unzip aside and move into place
	for await (const entry of Deno.readDir(base)) {
		await Deno.remove(`${base}/${entry.name}`, { recursive: true }).catch(() => {});
	}
	// the system unzip cannot read the compiled binary's virtual filesystem — stream the
	// zip out to a real temp file first (running from source it's a real file already)
	let zip = EMBEDDED_JRE_ZIP;
	let zipTempDir: string | undefined;
	if (isCompiledBinary()) {
		zipTempDir = await Deno.makeTempDir({ prefix: `${APP.id}-jre-zip-` });
		zip = `${zipTempDir}/jre.zip`;
		const from = await Deno.open(EMBEDDED_JRE_ZIP, { read: true });
		const to = await Deno.open(zip, { write: true, create: true, truncate: true });
		await from.readable.pipeTo(to.writable);
	}
	try {
		const staging = `${target}.partial-${crypto.randomUUID().slice(0, 8)}`;
		const result = await new Deno.Command("unzip", {
			args: ["-q", zip, "-d", staging],
			stdout: "piped",
			stderr: "piped",
		}).output();
		if (!result.success) {
			await Deno.remove(staging, { recursive: true }).catch(() => {});
			throw new Error(`could not extract the embedded Java runtime: ${new TextDecoder().decode(result.stderr).trim()}`);
		}
		await Deno.rename(staging, target);
	} finally {
		if (zipTempDir) await Deno.remove(zipTempDir, { recursive: true }).catch(() => {});
	}
	return java;
}

/** Which runtime javaBinary() resolves to: the embedded JRE (fat build), a system java, or none. */
export async function javaSource(): Promise<"embedded" | "system" | null> {
	if (await embeddedJre()) return "embedded";
	return await javaVersion() !== null ? "system" : null;
}

/**
 * Human-readable violation of the Java requirement, or null when satisfied — shown in the
 * status pill and Settings. A fat build always satisfies it (the embedded runtime ships javac
 * and matches the requirement).
 */
export async function javaProblem(): Promise<string | null> {
	if (await embeddedJre()) return null;
	const version = await javaVersion();
	if (version === null) return `no Java found — install a JDK ${REQUIRED_JAVA} or newer`;
	const major = javaMajor(version);
	if (major !== null && major < REQUIRED_JAVA) {
		return `Java ${major} found — the app needs a JDK ${REQUIRED_JAVA} or newer`;
	}
	// the keychain helper's source-launcher fallback compiles at run time — needs a full JDK
	if (keychainEnabled() && !await javacAvailable()) {
		return `no javac next to the Java runtime — a full JDK ${REQUIRED_JAVA} or newer is required`;
	}
	return null;
}

/** The major version out of a `java -version` line ("25.0.3" → 25, "1.8.0_281" → 8). */
function javaMajor(versionLine: string): number | null {
	const match = versionLine.match(/"(\d+)(?:\.(\d+))?/);
	if (!match) return null;
	return match[1] === "1" && match[2] ? Number(match[2]) : Number(match[1]);
}

let javacOkPromise: Promise<boolean> | undefined;

function javacAvailable(): Promise<boolean> {
	return javacOkPromise ??= (async () => {
		const javac = await javacBinary();
		if (!javac) return false;
		try {
			return (await new Deno.Command(javac, { args: ["-version"], stdout: "null", stderr: "null" }).output()).success;
		} catch {
			return false;
		}
	})();
}

/** The javac next to the resolved java, or null. */
async function javacBinary(): Promise<string | null> {
	const java = await javaBinary();
	const javac = java.replace(/java$/, "javac");
	if (javac === "javac") return "javac"; // bare PATH lookup; callers fall back if it is absent
	try {
		await Deno.stat(javac);
		return javac;
	} catch {
		return null;
	}
}

let javaVersionCache: string | null | undefined;

export async function javaVersion(): Promise<string | null> {
	if (javaVersionCache !== undefined) return javaVersionCache;
	javaVersionCache = await versionLineOf(await javaBinary());
	return javaVersionCache;
}

// ---------------------------------------------------------------------------
// embedded assets → real files for external java processes
// ---------------------------------------------------------------------------

function isCompiledBinary(): boolean {
	const execName = Deno.execPath().split(/[/\\]/).pop() ?? "";
	return execName !== "deno" && execName !== "deno.exe";
}

/**
 * Path of an embedded asset as seen by the external java process. In a `deno compile`d binary
 * embedded files live in the virtual filesystem, which only this process can read — materialize
 * them to real temp files once per run so `java` can read them.
 */
let scratchDir: string | undefined;
const materialized = new Map<string, string>();

export async function materialize(embedded: string, basename: string): Promise<string> {
	if (!isCompiledBinary()) return embedded;
	const cached = materialized.get(basename);
	if (cached) return cached;
	scratchDir ??= await Deno.makeTempDir({ prefix: `${APP.id}-` });
	const target = `${scratchDir}/${basename}`;
	await Deno.writeFile(target, await Deno.readFile(embedded));
	materialized.set(basename, target);
	return target;
}

// ---------------------------------------------------------------------------
// the keychain helper (used by server/keychain.ts when features.keychain is on)
// ---------------------------------------------------------------------------

const CP_SEP = Deno.build.os === "windows" ? ";" : ":";

export const keychainJarPath = () => materialize(EMBEDDED_KEYCHAIN_JAR, "keychain-cli.jar");
export const keychainHelperPath = () => materialize(EMBEDDED_KEYCHAIN_HELPER, "KeychainTool.java");

/**
 * Launch arguments for the keychain helper: the classes precompiled by `deno task compile`
 * when present (bare JVM startup), else the java source launcher (compiles the helper on
 * every call — the fallback for source runs without a build).
 */
export async function keychainToolCommand(): Promise<string[]> {
	const classes = await keychainClassesDir();
	const jar = await keychainJarPath();
	if (classes) return ["-cp", `${jar}${CP_SEP}${classes}`, "KeychainTool"];
	return ["-cp", jar, await keychainHelperPath()];
}

let keychainClassesPromise: Promise<string | null> | undefined;

function keychainClassesDir(): Promise<string | null> {
	return keychainClassesPromise ??= (async () => {
		try {
			const names: string[] = [];
			for await (const entry of Deno.readDir(EMBEDDED_KEYCHAIN_CLASSES)) {
				if (entry.isFile && entry.name.endsWith(".class")) names.push(entry.name);
			}
			if (!names.includes("KeychainTool.class")) return null;
			// running from source the directory is real; from the compiled binary it lives in the
			// virtual filesystem — copy the class files out so java can read them
			if (!isCompiledBinary()) return EMBEDDED_KEYCHAIN_CLASSES;
			scratchDir ??= await Deno.makeTempDir({ prefix: `${APP.id}-` });
			const target = `${scratchDir}/keychain-classes`;
			await Deno.mkdir(target, { recursive: true });
			for (const name of names) {
				await Deno.writeFile(`${target}/${name}`, await Deno.readFile(`${EMBEDDED_KEYCHAIN_CLASSES}/${name}`));
			}
			return target;
		} catch {
			return null; // no precompiled classes — the caller falls back to the source launcher
		}
	})();
}

// ---------------------------------------------------------------------------
// running Java work — the generic building blocks for your app's Java-backed features
// ---------------------------------------------------------------------------

/** Runs `java -jar <jar> <args…>` and returns the exit status plus trimmed output lines. */
export async function runJar(jar: string, args: string[]): Promise<{ ok: boolean; log: string[] }> {
	const result = await new Deno.Command(await javaBinary(), {
		args: ["-jar", jar, ...args],
		stdout: "piped",
		stderr: "piped",
	}).output();
	const decoder = new TextDecoder();
	const log = (decoder.decode(result.stdout) + "\n" + decoder.decode(result.stderr))
		.split(/[\r\n]+/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return { ok: result.success, log };
}

/** Reads a subprocess's stdout+stderr line by line (splitting on CR and LF), forwarding each. */
export async function readLines(child: Deno.ChildProcess, onLine: (line: string) => void): Promise<void> {
	const decoder = new TextDecoder();
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		let buffer = "";
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk, { stream: true });
			const parts = buffer.split(/[\r\n]+/);
			buffer = parts.pop() ?? "";
			for (const line of parts) onLine(line);
		}
		if (buffer) onLine(buffer);
	};
	await Promise.all([pump(child.stdout), pump(child.stderr)]);
}

/** Spawns `java -jar <jar> <args…>` streaming its output lines; resolves with the exit status. */
export async function runJarStreaming(
	jar: string,
	args: string[],
	onLine: (line: string) => void,
): Promise<{ ok: boolean }> {
	const child = new Deno.Command(await javaBinary(), {
		args: ["-jar", jar, ...args],
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	await readLines(child, onLine);
	const status = await child.status;
	return { ok: status.success };
}
