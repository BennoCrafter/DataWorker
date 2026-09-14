/**
 * UPDATES FEATURE: publishes the built macOS app to this repo's own `releases` branch on
 * GitHub — the in-app updater (server/update.ts) reads it back over plain HTTPS via
 * raw.githubusercontent.com (app.config.ts's repo.updateBase), no credentials needed since the
 * repo is public.
 *
 *   <app-id>-mac-<arch>.app.zip   the app
 *   manifest-mac-<arch>.json     {version, commit, file, size, sha256, stamp}
 *
 * `releases` holds only the latest publish: each run force-pushes a single fresh commit with
 * just those two files (an orphan branch, no parent), matching update.ts's "always overwritten,
 * no version history" model — and keeping that branch from growing a new ~60MB blob per publish
 * forever. Never edit that branch by hand; this script owns it entirely.
 *
 * Usage: deno task publish — uploads the ALREADY built app (it does not build). Refuses an app
 * that is not notarized + stapled, so the self-updater only ever installs a Gatekeeper-trusted
 * build; run `deno task notarize` first, or `deno task release` for the whole
 * build → notarize → publish chain. Requires push access to this repo's GitHub remote (the
 * same `git push` credentials already set up for normal commits).
 */

import { fromFileUrl } from "@std/path";
import { APP, updateBase } from "../app.config.ts";
import { artifactName, manifestName } from "../server/update.ts";
import { currentVersion } from "../server/version.ts";
import { fileSha256 } from "../server/repo.ts";

const variant = "slim"; // this app never turns on features.java, so there is only one variant

// fromFileUrl so a checkout path with spaces resolves
const root = fromFileUrl(new URL("../", import.meta.url));
const dist = `${root}dist/`;
// must match the branch segment in app.config.ts's repo.updateBase URL
const BRANCH = "releases";

if (Deno.build.os !== "darwin") throw new Error("publishing is only wired up for macOS here");

const stamp = await currentVersion();
if (!stamp) throw new Error("version.json is missing — run `deno task build` first");

const app = `${dist}${APP.name}.app`;
await Deno.stat(app).catch(() => {
	throw new Error(`dist/${APP.name}.app is missing — run \`deno task build\` first`);
});
await requireNotarized(app);

console.log("zipping the app...");
const zip = `${dist}${artifactName(variant)}`;
await Deno.remove(zip).catch(() => {});
// -y keeps symlinks; zip from inside dist so the archive root is "<App Name>.app/"
const zipResult = await new Deno.Command("zip", { args: ["-qry", zip, `${APP.name}.app`], cwd: dist }).output();
if (!zipResult.success) throw new Error("zip failed");

const size = (await Deno.stat(zip)).size;
console.log(`computing checksum of ${artifactName(variant)} (${megabytes(size)})...`);
const sha256 = await fileSha256(zip);

const manifest = {
	version: stamp.version,
	commit: stamp.commit ?? null,
	file: artifactName(variant),
	size,
	sha256,
	stamp: Date.now(),
};

console.log(`publishing to the '${BRANCH}' branch...`);
await publishToGitBranch(zip, manifest);

console.log(`published ${stamp.version}${stamp.commit ? ` (${stamp.commit})` : ""}`);
console.log(`  ${updateBase()}/${artifactName(variant)}`);
console.log(`  ${updateBase()}/${manifestName(variant)}`);

/** Force-pushes a single orphan commit with just the artifact + manifest to BRANCH. */
async function publishToGitBranch(artifactPath: string, manifestObj: Record<string, unknown>): Promise<void> {
	const worktree = await Deno.makeTempDir({ prefix: "publish-releases-" });
	const tempBranch = `publish-tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		await run(["git", "worktree", "add", "--detach", worktree], root);
		await run(["git", "checkout", "--orphan", tempBranch], worktree);
		// checkout --orphan keeps the working tree as-is (just detaches history) — clear it so
		// this commit holds ONLY the two published files, nothing from the source tree
		for await (const entry of Deno.readDir(worktree)) {
			if (entry.name === ".git") continue;
			await Deno.remove(`${worktree}/${entry.name}`, { recursive: true });
		}
		await Deno.copyFile(artifactPath, `${worktree}/${artifactName(variant)}`);
		await Deno.writeTextFile(
			`${worktree}/${manifestName(variant)}`,
			JSON.stringify(manifestObj, null, "\t") + "\n",
		);
		await run(["git", "add", "-A"], worktree);
		await run(["git", "commit", "-m", `Publish ${manifestObj.version}`], worktree);
		await run(["git", "push", "origin", `${tempBranch}:${BRANCH}`, "--force"], worktree);
	} finally {
		await run(["git", "worktree", "remove", "--force", worktree], root).catch(() => {});
		await run(["git", "branch", "-D", tempBranch], root).catch(() => {});
	}
}

async function run(args: string[], cwd: string): Promise<void> {
	const result = await new Deno.Command(args[0], { args: args.slice(1), cwd }).output();
	if (!result.success) {
		throw new Error(`${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
	}
}

/**
 * Refuses to publish a macOS app that is not notarized + stapled, so the self-updater never
 * hands users a build Gatekeeper distrusts (the swapped-in app relies on the ticket that lives
 * inside the bundle). `xcrun stapler validate` succeeds only once a ticket is stapled, which in
 * turn requires the Developer ID signature + successful notarization (`deno task notarize`).
 */
async function requireNotarized(appPath: string): Promise<void> {
	const validate = await new Deno.Command("xcrun", { args: ["stapler", "validate", appPath] })
		.output()
		.catch(() => null);
	if (!validate?.success) {
		throw new Error(
			"the app is not notarized/stapled — run `deno task notarize` first " +
				"(or `deno task release` to build + notarize + publish)",
		);
	}
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
