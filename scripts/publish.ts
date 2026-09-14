/**
 * UPDATES FEATURE: publishes the built platform app to the repository under FIXED names —
 * every publish overwrites the previous one, no version history is kept. With the java feature
 * on there are two variants, each under its own names (fat suffixed "-fat", slim unsuffixed):
 *
 *   <app-id>-mac-<arch>[-fat].app.zip / <app-id>-linux-<arch>[-fat].AppImage   the app
 *   manifest-<platform>[-fat].json     {version, commit, file, size, sha256, stamp}
 *
 * The in-app updater (server/update.ts) polls the manifest of ITS OWN variant and offers the
 * download when its version is newer than the running build's version.json.
 *
 * Usage: deno task publish — uploads the ALREADY built app (it does not build). The variant
 * is read from dist/.variant (written by `deno task compile`), so the artifact can never land
 * under the other variant's names; --slim/--fat override explicitly. On macOS it refuses an
 * app that is not notarized + stapled, so the self-updater only ever installs a Gatekeeper-
 * trusted build; run `deno task notarize` first, or `deno task release` for the whole
 * build → notarize → publish chain. Uploading needs deploy rights on the repository (same
 * credential chain as the downloads, see server/repo.ts).
 */

import { fromFileUrl } from "@std/path";
import { APP, appEnv, updateBase } from "../app.config.ts";
import { artifactName, manifestName, type Variant } from "../server/update.ts";
import { currentVersion } from "../server/version.ts";
import { fileSha256, uploadFile } from "../server/repo.ts";

// fromFileUrl so a checkout path with spaces resolves
const dist = fromFileUrl(new URL("../dist/", import.meta.url));

const variant: Variant = await resolveVariant();
console.log(`publishing the ${variant} variant`);

/** --slim/--fat wins; else the variant of the last build (dist/.variant) — never a blind default. */
async function resolveVariant(): Promise<Variant> {
	if (Deno.args.includes("--slim")) return "slim";
	if (Deno.args.includes("--fat")) return "fat";
	const marker = await Deno.readTextFile(`${dist}.variant`).then((text) => text.trim()).catch(() => null);
	if (marker === "slim" || marker === "fat") return marker;
	throw new Error(
		"cannot tell which variant dist/ holds — run `deno task build`/`build:fat` first, or pass --slim/--fat",
	);
}

const stamp = await currentVersion();
if (!stamp) throw new Error("version.json is missing — run `deno task build` first");

const artifact = await platformArtifact();
const size = (await Deno.stat(artifact)).size;
console.log(`computing checksum of ${artifactName(variant)} (${megabytes(size)})...`);
const sha256 = await fileSha256(artifact);

console.log(`uploading ${artifactName(variant)} (${megabytes(size)})...`);
const info = await uploadFile(`${updateBase()}/${artifactName(variant)}`, await Deno.readFile(artifact), {
	"X-Checksum-Sha256": sha256,
});

const manifest = {
	version: stamp.version,
	commit: stamp.commit ?? null,
	file: artifactName(variant),
	size,
	sha256,
	stamp: Date.now(),
};
console.log(`uploading ${manifestName(variant)}...`);
await uploadJson(manifestName(variant), manifest);

console.log(
	`published ${stamp.version}${stamp.commit ? ` (${stamp.commit})` : ""} [${variant}]${
		info.authenticated ? " (authenticated)" : ""
	}`,
);
console.log(`  ${updateBase()}/${artifactName(variant)}`);
console.log(`  ${updateBase()}/${manifestName(variant)}`);

async function uploadJson(name: string, body: Record<string, unknown>): Promise<void> {
	await uploadFile(
		`${updateBase()}/${name}`,
		new TextEncoder().encode(JSON.stringify(body, null, "\t") + "\n"),
		{ "Content-Type": "application/json" },
	);
}

/** The app package built by `deno task build`; on macOS the .app is zipped first. */
async function platformArtifact(): Promise<string> {
	if (Deno.build.os === "darwin") {
		const app = `${dist}${APP.name}.app`;
		await Deno.stat(app).catch(() => {
			throw new Error(`dist/${APP.name}.app is missing — run \`deno task build\` first`);
		});
		await requireNotarized(app);
		const zip = `${dist}${artifactName(variant)}`;
		console.log("zipping the app...");
		await Deno.remove(zip).catch(() => {});
		// -y keeps symlinks; zip from inside dist so the archive root is "<App Name>.app/"
		const result = await new Deno.Command("zip", { args: ["-qry", zip, `${APP.name}.app`], cwd: dist }).output();
		if (!result.success) throw new Error("zip failed");
		return zip;
	}
	if (Deno.build.os === "linux") {
		// make-app.sh names it by `uname -m`, which matches Deno.build.arch on linux
		const appimage = `${dist}${APP.id}-${Deno.build.arch}.AppImage`;
		await Deno.stat(appimage).catch(() => {
			throw new Error(`${appimage} is missing — run \`deno task build\` first`);
		});
		return appimage;
	}
	throw new Error(`publishing is not supported on ${Deno.build.os}`);
}

/**
 * Refuses to publish a macOS app that is not notarized + stapled, so the self-updater never
 * hands users a build Gatekeeper distrusts (the swapped-in app relies on the ticket that lives
 * inside the bundle). `xcrun stapler validate` succeeds only once a ticket is stapled, which in
 * turn requires the Developer ID signature + successful notarization. Set
 * <envPrefix>_ALLOW_UNNOTARIZED=1 to publish an ad-hoc test build (e.g. to a fake repo).
 */
async function requireNotarized(app: string): Promise<void> {
	if (appEnv("ALLOW_UNNOTARIZED")) {
		console.warn(`⚠️  ${APP.envPrefix}_ALLOW_UNNOTARIZED set — publishing without a notarization check`);
		return;
	}
	const validate = await new Deno.Command("xcrun", { args: ["stapler", "validate", app] })
		.output()
		.catch(() => null);
	if (!validate?.success) {
		throw new Error(
			"the app is not notarized/stapled — run `deno task notarize` first " +
				"(or `deno task release` to build + notarize + publish; " +
				`set ${APP.envPrefix}_ALLOW_UNNOTARIZED=1 to publish a test build anyway)`,
		);
	}
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
