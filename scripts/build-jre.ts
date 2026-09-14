/**
 * JAVA FEATURE: builds the Java runtime that the FAT client variant embeds (`deno task
 * build:fat`; the slim variant ships no runtime and uses the system JDK instead, see
 * server/java.ts):
 *
 *   prep/jre.zip — a thinned runtime: the full Java SE API surface (java.se) plus the JDK
 *   service providers Java apps actually hit, plus jdk.compiler (needed when the keychain
 *   feature's source-launcher fallback or your own helpers compile at run time), built by
 *   jlink from the fixed Eclipse Temurin JDK configured in APP.java.jdkRelease. Macs always
 *   get the Apple silicon build; linux/windows follow the build machine's architecture.
 *   Skipped when prep/jre.zip already holds this release with this module/locale spec.
 *
 * Usage: deno task build:jre [--force]    (also runs as the first step of `deno task build:fat`)
 */

import { fromFileUrl } from "@std/path";
import { APP } from "../app.config.ts";
import { downloadFile } from "./repo-download.ts";

const JDK_RELEASE = APP.java.jdkRelease;

// The thinned module set. java.se keeps the ENTIRE SE API surface on purpose: downloaded
// components update independently of the app, so dropping SE modules (java.desktop, java.sql,
// …) could break a future component at users. What IS dropped never gets linked by application
// code: the experimental Graal JIT (jdk.graal.compiler + jdk.internal.vm.ci, the single biggest
// chunk), JFR/debug/management agents (jdk.jfr, jdk.jdwp.agent, jdk.management.agent), and dead
// ends like smartcards, SCTP and the incubator vector API.
const JRE_MODULES = "java.se,jdk.charsets,jdk.compiler,jdk.crypto.cryptoki,jdk.dynalink,jdk.httpserver," +
	"jdk.localedata,jdk.management,jdk.naming.dns,jdk.naming.rmi,jdk.net,jdk.nio.mapmode,jdk.security.auth," +
	"jdk.security.jgss,jdk.unsupported,jdk.xml.dom,jdk.zipfs";

// jdk.localedata trimmed to these languages (the bulk of the module is hundreds of locales);
// formatting in any other locale falls back to root-locale patterns instead of failing
const LOCALES = APP.java.jreLocales;

// stamped into jre-info.json so a cached prep/jre.zip built with a different set is rebuilt
const SPEC = `${JRE_MODULES}|locales=${LOCALES}`;

const force = Deno.args.includes("--force");

const target = path("prep/jre.zip");
const infoFile = path("prep/jre-info.json");

// macs ship the Apple silicon build only; linux/windows follow the build machine's arch
const os = Deno.build.os === "darwin" ? "mac" : Deno.build.os === "windows" ? "windows" : "linux";
const arch = os === "mac" || Deno.build.arch === "aarch64" ? "aarch64" : "x64";
// what the runtime check in server/java.ts compares against Deno.build
const infoArch = arch === "aarch64" ? "aarch64" : "x86_64";
const version = `Eclipse Temurin ${JDK_RELEASE} JRE`;

if (!force && await isCurrent()) {
	console.log(`prep/jre.zip already holds ${version} (${os}-${arch}) — skipping (use --force to rebuild)`);
} else {
	await buildJre();
}

async function buildJre(): Promise<void> {
	// the full JDK is downloaded (the JRE image lacks jdk.compiler and cannot be extended);
	// its own jlink then builds the runtime, so the result never depends on a local JDK
	const source = `https://api.adoptium.net/v3/binary/version/${encodeURIComponent(JDK_RELEASE)}/${os}/${arch}` +
		`/jdk/hotspot/normal/eclipse`;
	const extension = os === "windows" ? "zip" : "tar.gz";

	const temp = await Deno.makeTempDir({ prefix: `${APP.id}-jre-` });
	const archive = `${temp}/temurin.${extension}`;
	console.log(`downloading Eclipse Temurin ${JDK_RELEASE} (${os}-${arch})...`);
	await downloadFile(source, archive, `temurin.${extension}`);

	console.log("extracting...");
	const extracted = `${temp}/extracted`;
	await Deno.mkdir(extracted);
	await run("tar", "-xf", archive, "-C", extracted);
	// the archive holds a single jdk-… directory; on macOS the JDK nests under Contents/Home
	const home = `${extracted}/${await onlyDir(extracted)}${os === "mac" ? "/Contents/Home" : ""}`;

	console.log("building the runtime (jlink)...");
	const runtime = `${temp}/runtime`;
	const jlink = `${home}/bin/jlink${os === "windows" ? ".exe" : ""}`;
	// modules stay uncompressed: jlink-compressed lib/modules barely shrinks the shipped zip
	// (pre-compressed data doesn't re-compress) but costs class-load time in the many short
	// helper processes — the outer zip compresses the uncompressed image much better
	await run(
		jlink,
		"--add-modules",
		JRE_MODULES,
		"--include-locales",
		LOCALES,
		"--no-header-files",
		"--no-man-pages",
		"--output",
		runtime,
	);

	console.log("zipping...");
	await Deno.remove(target).catch(() => {});
	// -y keeps symlinks as symlinks; zip from inside the runtime dir so the archive root is bin/, lib/, ...
	const zip = await new Deno.Command("zip", { args: ["-qry", target, "."], cwd: runtime, stderr: "piped" })
		.output();
	if (!zip.success) throw new Error(`zip failed:\n${new TextDecoder().decode(zip.stderr)}`);
	await Deno.remove(temp, { recursive: true }).catch(() => {});

	await Deno.writeTextFile(
		infoFile,
		JSON.stringify({ version, os: Deno.build.os, arch: infoArch, stamp: Date.now(), spec: SPEC }) + "\n",
	);
	console.log(`prep/jre.zip ← ${version} (${os}-${arch})`);
}

// --- helpers --------------------------------------------------------------------------------

function path(relative: string): string {
	// fromFileUrl (not URL.pathname) so a checkout path with spaces decodes %20 back to a space
	return fromFileUrl(new URL(`../${relative}`, import.meta.url));
}

async function isCurrent(): Promise<boolean> {
	try {
		const info = JSON.parse(await Deno.readTextFile(infoFile));
		await Deno.stat(target);
		return info?.version === version && info?.os === Deno.build.os && info?.arch === infoArch &&
			info?.spec === SPEC;
	} catch {
		return false;
	}
}

async function run(cmd: string, ...cmdArgs: string[]): Promise<void> {
	const result = await new Deno.Command(cmd, { args: cmdArgs, stdout: "piped", stderr: "piped" }).output();
	if (!result.success) {
		throw new Error(`${cmd} ${cmdArgs.join(" ")} failed:\n${new TextDecoder().decode(result.stderr)}`);
	}
}

async function onlyDir(parent: string): Promise<string> {
	for await (const entry of Deno.readDir(parent)) {
		if (entry.isDirectory) return entry.name;
	}
	throw new Error(`no directory found in the extracted archive at ${parent}`);
}
