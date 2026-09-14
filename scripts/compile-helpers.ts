/**
 * KEYCHAIN FEATURE: precompiles helper/KeychainTool.java against jars/keychain-cli.jar into
 * helper/classes/, which `deno task compile` embeds (the whole helper/ tree is included). A
 * source-launched helper pays a javac compile on EVERY invocation (~0.5-1s) — precompiled
 * classes cut a keychain call down to bare JVM startup.
 *
 * javac comes from JAVA_HOME or the PATH and compiles with --release <APP.java.required> so
 * the shipped class files match the app's stated requirement even when the build machine runs
 * a newer JDK.
 *
 * Usage: runs as part of `deno task compile` (scripts/compile.ts, keychain feature only).
 */
import { fromFileUrl } from "@std/path";
import { APP } from "../app.config.ts";

// fromFileUrl so a checkout path with spaces resolves
const root = fromFileUrl(new URL("../", import.meta.url));
const classes = `${root}helper/classes`;

const { javac } = await findJavac();
await Deno.remove(classes, { recursive: true }).catch(() => {});
await Deno.mkdir(classes, { recursive: true });
const result = await new Deno.Command(javac, {
	args: [
		"--release",
		String(APP.java.required),
		"-cp",
		`${root}jars/keychain-cli.jar`,
		"-d",
		classes,
		`${root}helper/KeychainTool.java`,
	],
	stdout: "piped",
	stderr: "piped",
}).output();
if (!result.success) {
	throw new Error(`javac failed:\n${new TextDecoder().decode(result.stderr)}`);
}
const names: string[] = [];
for await (const entry of Deno.readDir(classes)) names.push(entry.name);
console.log(`helper/classes ← ${names.sort().join(", ")}`);

/** A javac to compile with: JAVA_HOME or the PATH. */
async function findJavac(): Promise<{ javac: string }> {
	const executable = Deno.build.os === "windows" ? "javac.exe" : "javac";
	const home = Deno.env.get("JAVA_HOME");
	if (home) {
		const candidate = `${home}/bin/${executable}`;
		try {
			await Deno.stat(candidate);
			return { javac: candidate };
		} catch {
			// fall through
		}
	}
	try {
		const probe = await new Deno.Command(executable, { args: ["-version"], stdout: "null", stderr: "null" })
			.output();
		if (probe.success) return { javac: executable };
	} catch {
		// no javac on the PATH
	}
	throw new Error(`no javac found (JAVA_HOME/PATH) — building needs a JDK ${APP.java.required} or newer`);
}
