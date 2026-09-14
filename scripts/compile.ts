/**
 * Compile driver — assembles and runs the `deno compile` command, embedding ui/, version.json
 * (written fresh here) and icon.png into the binary.
 *
 * Also writes dist/.appmeta (shell-sourceable identity for make-app.sh / notarize.sh).
 *
 * Usage: deno task compile (via the build tasks)
 */
import { fromFileUrl } from "@std/path";
import { APP } from "../app.config.ts";

// fromFileUrl so a checkout path with spaces resolves
const root = fromFileUrl(new URL("../", import.meta.url));

// 1. bake the build identity
await import("./write-version.ts");

// 2. assemble the compile command
const includes = ["server.ts", "ui", "version.json", "icon.png"];

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

// 3. build metadata for the packaging scripts
await Deno.mkdir(`${root}dist`, { recursive: true });
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
console.log(`compiled dist/${APP.id}`);

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
