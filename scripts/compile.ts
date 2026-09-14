/**
 * Feature-aware compile driver — assembles and runs the `deno compile` command from
 * app.config.ts, so the binary only embeds what the enabled features need:
 *
 *   always                 ui/, version.json (written fresh here), icon.png
 *   features.keychain      jars/keychain-cli.jar + helper/ (KeychainTool precompiled first)
 *   --fat (features.java)  prep/jre.zip + prep/jre-info.json (built by `deno task build:jre`)
 *
 * Also writes dist/.variant (fat|slim — publish reads it so an artifact can never land under
 * the other variant's names) and dist/.appmeta (shell-sourceable identity for make-app.sh /
 * notarize.sh).
 *
 * Usage: deno task compile | deno task compile:fat  (via the build tasks)
 */
import { fromFileUrl } from "@std/path";
import { APP, keychainEnabled } from "../app.config.ts";

const fat = Deno.args.includes("--fat");
if (fat && !APP.features.java) {
	throw new Error("--fat embeds a Java runtime, but features.java is off — enable it or build slim");
}

// fromFileUrl so a checkout path with spaces resolves
const root = fromFileUrl(new URL("../", import.meta.url));

// 1. bake the build identity
await import("./write-version.ts");

// 2. keychain feature: precompile the helper so keychain calls skip the per-call javac
if (keychainEnabled()) await import("./compile-helpers.ts");

// 3. fat variant: the embedded JRE must already be built (deno task build:jre)
if (fat) {
	try {
		await Deno.stat(`${root}prep/jre.zip`);
		await Deno.stat(`${root}prep/jre-info.json`);
	} catch {
		throw new Error("prep/jre.zip is missing — run `deno task build:jre` first (or `deno task build:fat`)");
	}
}

// 4. assemble the compile command
const includes = ["server.ts", "ui", "version.json", "icon.png"];
if (keychainEnabled()) includes.push("jars/keychain-cli.jar", "helper");
if (fat) includes.push("prep/jre.zip", "prep/jre-info.json");

const args = [
	"compile",
	"--output",
	`dist/${APP.id}`,
	"--unstable-ffi",
	"--allow-ffi",
	"--allow-net",
	"--allow-read",
	"--allow-write",
	"--allow-env",
	"--allow-run",
	...includes.flatMap((include) => ["--include", include]),
	"main.ts",
];

console.log(`deno ${args.join(" ")}`);
const compile = await new Deno.Command(Deno.execPath(), { args, cwd: root }).output();
if (!compile.success) throw new Error("deno compile failed");

// 5. build metadata for the packaging scripts
await Deno.mkdir(`${root}dist`, { recursive: true });
await Deno.writeTextFile(`${root}dist/.variant`, `${fat ? "fat" : "slim"}\n`);
await Deno.writeTextFile(
	`${root}dist/.appmeta`,
	[
		`APP_NAME=${shellQuote(APP.name)}`,
		`APP_ID=${shellQuote(APP.id)}`,
		`APP_BUNDLE_ID=${shellQuote(APP.macBundleId)}`,
		`APP_ENV_PREFIX=${shellQuote(APP.envPrefix)}`,
		"",
	].join("\n"),
);
console.log(`compiled dist/${APP.id} (${fat ? "fat" : "slim"})`);

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
