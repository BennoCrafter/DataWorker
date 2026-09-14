/**
 * Writes version.json — the build identity `deno task compile` bakes into the app: an ISO UTC
 * build timestamp used as the version (the in-app updater compares it against the published
 * manifest; ISO strings order chronologically), plus the git commit when available.
 */
import { fromFileUrl } from "@std/path";

const result = await new Deno.Command("git", {
	args: ["rev-parse", "--short", "HEAD"],
	stdout: "piped",
	stderr: "null",
}).output().catch(() => null);
const commit = result?.success ? new TextDecoder().decode(result.stdout).trim() : null;

const version = new Date().toISOString().replace(/\.\d+Z$/, "Z");
// fromFileUrl so a checkout path with spaces resolves (URL.pathname would keep %20)
const target = fromFileUrl(new URL("../version.json", import.meta.url));
await Deno.writeTextFile(target, JSON.stringify({ version, commit }) + "\n");
console.log(`version.json ← ${version}${commit ? ` (${commit})` : ""}`);
