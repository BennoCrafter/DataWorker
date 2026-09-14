/**
 * OPTIONAL FEATURE (features.keychain, requires features.java): secrets via the denkbares
 * keychain. ONE store is used: the encrypted keychain file (`DES_KEYCHAIN` env else ~/.des-kch),
 * the same file the denkbares CLI and build tooling use — repository credentials live there
 * under entry keys that are Java REGEXES matched against download URLs.
 *
 * The tricky part is its unlock password. The keychain library reads it from DES_KEYCHAIN_PW,
 * but a Finder-launched app has no shell environment. So the password is resolved as:
 *
 *   1. the DES_KEYCHAIN_PW environment variable, when present (terminal starts, CI — and the
 *      only supported source on Linux, expected to already be set);
 *   2. macOS only: the login Keychain (via the `security` CLI), where the Settings popover
 *      stores it once — available to the user session however the app was launched.
 *
 * This keeps the credentials in the standard denkbares keychain (so other tooling sees them
 * too) while making them reachable from a double-clicked app on macOS, and never writes a
 * secret to a plaintext file.
 *
 * All keychain access runs helper/KeychainTool.java on jars/keychain-cli.jar (precompiled
 * classes when the build embedded them, the source launcher otherwise). Library facts
 * (verified): entry KEYS are Java regexes matched against URLs; a missing passphrase silently
 * yields a volatile in-memory provider; a wrong passphrase fails with "Invalid keychain
 * password".
 */

import { APP, appEnv } from "../app.config.ts";
import { javaBinary, keychainToolCommand } from "./java.ts";

export type PasswordSource = "environment" | "macos-keychain";

export type KeychainSnapshot = {
	/** true = opened the keychain, false = wrong password, null = no password configured. */
	ok: boolean | null;
	token: string | null;
	userPassword: string | null;
	error?: string;
};

/** What the Settings popover shows about the keychain. Reuses the cached snapshot. */
export type KeychainOverview = {
	file: string;
	exists: boolean;
	/** Where the unlock password comes from, or null when none is configured. */
	passwordSource: PasswordSource | null;
	/** Password present AND it opens the keychain (or the keychain does not exist yet). */
	unlocked: boolean;
	/** macOS with no DES_KEYCHAIN_PW override — the app can store the password itself. */
	canStorePassword: boolean;
	/** A password is currently stored in the macOS login Keychain. */
	managed: boolean;
	error?: string;
};

// ---------------------------------------------------------------------------
// the keychain file
// ---------------------------------------------------------------------------

/** The keychain file the library uses: DES_KEYCHAIN override else ~/.des-kch. */
export function keychainFile(): string {
	return Deno.env.get("DES_KEYCHAIN") ?? `${Deno.env.get("HOME") ?? "~"}/.des-kch`;
}

/** Explicit env for a helper run, so an inherited DES_KEYCHAIN(_PW) can't redirect access. */
function toolEnv(password: string): Record<string, string> {
	return { DES_KEYCHAIN: keychainFile(), DES_KEYCHAIN_PW: password };
}

// ---------------------------------------------------------------------------
// password resolution: environment, then the macOS login Keychain
// ---------------------------------------------------------------------------

export async function keychainPassword(): Promise<{ value: string; source: PasswordSource } | null> {
	const env = Deno.env.get("DES_KEYCHAIN_PW");
	if (env) return { value: env, source: "environment" };
	if (Deno.build.os === "darwin") {
		const stored = await macosPasswordGet();
		if (stored !== null) return { value: stored, source: "macos-keychain" };
	}
	return null;
}

/** macOS only: the app can persist the password itself unless the environment already sets it. */
function canStorePassword(): boolean {
	return Deno.build.os === "darwin" && !Deno.env.get("DES_KEYCHAIN_PW");
}

// the login Keychain entry that holds the keychain's unlock password — ONE fixed service name
// shared by all denkbares apps, so the password is stored once and every app finds it
const MACOS_SERVICE = "com.denkbares.keychain";
// service names older app versions stored the password under (the per-app bundle id, and the
// bundle-tool entry that harbor shared) — a password found there is adopted into the shared
// entry on first read; the legacy entry itself is left in place for older builds still reading it
const MACOS_LEGACY_SERVICES = [APP.macBundleId, "com.denkbares.bundle-tool"];
const MACOS_ACCOUNT = "des-keychain-password";

/** Advanced/testing: target a specific keychain file instead of the login keychain. */
function macosKeychainArg(): string[] {
	const override = appEnv("MACOS_KEYCHAIN");
	return override ? [override] : [];
}

async function macosPasswordGet(): Promise<string | null> {
	const stored = await macosPasswordFind(MACOS_SERVICE);
	if (stored !== null) return stored;
	// migration: adopt a password an older app version stored under a legacy service name
	for (const service of MACOS_LEGACY_SERVICES) {
		if (service === MACOS_SERVICE) continue;
		const legacy = await macosPasswordFind(service);
		if (legacy !== null) {
			await macosPasswordSet(legacy).catch(() => {}); // reads still work when adoption fails
			return legacy;
		}
	}
	return null;
}

async function macosPasswordFind(service: string): Promise<string | null> {
	try {
		const output = await new Deno.Command("security", {
			args: ["find-generic-password", "-s", service, "-a", MACOS_ACCOUNT, "-w", ...macosKeychainArg()],
			stdout: "piped",
			stderr: "null",
		}).output();
		if (!output.success) return null; // exit 44 = no such item
		return new TextDecoder().decode(output.stdout).replace(/\n$/, "");
	} catch {
		return null; // `security` unavailable
	}
}

async function macosPasswordSet(password: string): Promise<void> {
	const output = await new Deno.Command("security", {
		// -U updates the entry when it already exists
		args: [
			"add-generic-password",
			"-U",
			"-s",
			MACOS_SERVICE,
			"-a",
			MACOS_ACCOUNT,
			"-w",
			password,
			...macosKeychainArg(),
		],
		stdout: "null",
		stderr: "piped",
	}).output();
	if (!output.success) {
		throw new Error(
			`could not store the password in the macOS Keychain: ${new TextDecoder().decode(output.stderr).trim()}`,
		);
	}
}

async function macosPasswordDelete(): Promise<void> {
	// clears the legacy entries too — otherwise the next read would simply re-adopt them
	for (const service of new Set([MACOS_SERVICE, ...MACOS_LEGACY_SERVICES])) {
		await new Deno.Command("security", {
			args: ["delete-generic-password", "-s", service, "-a", MACOS_ACCOUNT, ...macosKeychainArg()],
			stdout: "null",
			stderr: "null",
		}).output();
	}
}

/**
 * Stores (empty clears) the keychain's unlock password in the macOS login Keychain, after
 * checking it actually opens an existing keychain. macOS only; elsewhere the password must
 * come from DES_KEYCHAIN_PW.
 */
export async function storeKeychainPassword(password: string): Promise<KeychainOverview> {
	if (Deno.env.get("DES_KEYCHAIN_PW")) {
		throw new Error("the keychain password comes from the environment (DES_KEYCHAIN_PW) — unset it to manage it here");
	}
	if (Deno.build.os !== "darwin") {
		throw new Error("password storage is only available on macOS — set DES_KEYCHAIN_PW in your environment");
	}
	const value = password.trim();
	if (!value) {
		await macosPasswordDelete();
		snapshots.clear();
		return keychainOverview(APP.repo.updateBase);
	}
	// verify against an existing keychain; a not-yet-created one is accepted (created on first write)
	if (await exists(keychainFile())) {
		const opens = await opensWith(value);
		if (opens === false) throw new Error(`the password does not open the keychain at ${keychainFile()}`);
	}
	await macosPasswordSet(value);
	snapshots.clear();
	return keychainOverview(APP.repo.updateBase);
}

/** Whether `password` opens the keychain file: true / false / null (could not check, e.g. no java). */
async function opensWith(password: string): Promise<boolean | null> {
	try {
		const result = await runKeychainTool(["ls"], toolEnv(password));
		if (result.code === 0) return true;
		if (result.stderr.includes("Invalid keychain password")) return false;
		return null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// reads — one cached snapshot (one helper run) over the keychain
//
// Reads are the norm: credentials are expected to already be there (managed with KeychainCLI).
// The app writes exactly one thing, and only when the user pastes it into the prerequisites
// gate or Settings: a repository token (storeKeychainToken below).
// ---------------------------------------------------------------------------

/**
 * Everything the credential chain needs about `url` in ONE helper run: whether the keychain
 * opens, and the best token / user-password for the URL. Cached briefly — every helper call
 * is a JVM spawn, so per-lookup calls are the enemy.
 */
export function keychainSnapshot(url: string): Promise<KeychainSnapshot> {
	const cached = snapshots.get(url);
	if (cached && Date.now() - cached.at < SNAPSHOT_TTL) return cached.value;
	const value = loadSnapshot(url);
	snapshots.set(url, { at: Date.now(), value });
	return value;
}

const SNAPSHOT_TTL = 15_000;
const snapshots = new Map<string, { at: number; value: Promise<KeychainSnapshot> }>();

async function loadSnapshot(url: string): Promise<KeychainSnapshot> {
	const password = await keychainPassword();
	if (!password) return { ok: null, token: null, userPassword: null };
	// probe order = the credential conventions the app understands, most specific first:
	// a regex-key match against the URL, then well-known plain keys derived from its host
	const host = hostOf(url);
	const probes = [
		`m:${url}`,
		...(host
			? [
				`k:${host}:token`,
				`k:${host}:user-password`,
				"k:artifactory:token",
				"k:artifactory:user-password",
				`k:${host}`,
			]
			: []),
		"k:artifactory",
	];
	let result: { code: number; stdout: string; stderr: string };
	try {
		result = await runKeychainTool(["status", ...probes], toolEnv(password.value));
	} catch {
		return { ok: null, token: null, userPassword: null, error: "no Java runtime available — keychain not readable" };
	}
	if (result.code !== 0) return { ok: false, token: null, userPassword: null, error: friendlyError(result.stderr) };
	const snapshot: KeychainSnapshot = { ok: true, token: null, userPassword: null };
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("token ")) snapshot.token = decodeCredential(line.slice("token ".length));
		else if (line.startsWith("user-password ")) {
			snapshot.userPassword = decodeCredential(line.slice("user-password ".length));
		}
	}
	return snapshot;
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).host || null;
	} catch {
		return null;
	}
}

/** The helper base64-encodes credentials so multi-line values stay on one output line. */
function decodeCredential(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "-") return null;
	try {
		return new TextDecoder().decode(Uint8Array.from(atob(trimmed), (char) => char.charCodeAt(0)));
	} catch {
		return null;
	}
}

/**
 * Stores a token under `key` in the denkbares keychain — the one write the app performs, for a
 * token the user pasted into the prerequisites gate / Settings. The keychain file is created on
 * this first write when it does not exist yet, so its unlock password must already be set.
 */
export async function storeKeychainToken(key: string, token: string): Promise<void> {
	const value = token.trim();
	if (!value) throw new Error("no token given");
	const password = await keychainPassword();
	if (!password) {
		throw new Error(
			canStorePassword()
				? "the keychain is locked — set its unlock password first"
				: "the keychain is locked — set DES_KEYCHAIN_PW in your environment first",
		);
	}
	const result = await runKeychainTool(["set", key, "token"], toolEnv(password.value), `${value}\n`);
	if (result.code !== 0) throw new Error(friendlyError(result.stderr));
	snapshots.clear(); // the next lookup must see the credential just written
}

export async function keychainOverview(url: string): Promise<KeychainOverview> {
	const password = await keychainPassword();
	const file = keychainFile();
	const snapshot = password ? await keychainSnapshot(url) : null;
	return {
		file,
		exists: await exists(file),
		passwordSource: password?.source ?? null,
		// no password → not unlocked; a not-yet-created keychain with a password counts as ready
		unlocked: password !== null && snapshot?.ok !== false,
		canStorePassword: canStorePassword(),
		managed: password?.source === "macos-keychain",
		error: snapshot?.error,
	};
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

/** Maps the helper's stack traces to a short, actionable message. */
function friendlyError(stderr: string): string {
	if (stderr.includes("Invalid keychain password")) {
		return canStorePassword()
			? `the stored password no longer opens the keychain at ${keychainFile()} — set it again in Settings`
			: `wrong DES_KEYCHAIN_PW for ${keychainFile()}`;
	}
	return stderr.split("\n")[0]?.replace(/^Exception in thread "main"\s*/, "") || "keychain access failed";
}

/** Runs the helper; `input` (secret values for `set`) is piped to its stdin, never argv. */
async function runKeychainTool(
	args: string[],
	env: Record<string, string> | undefined,
	input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = new Deno.Command(await javaBinary(), {
		args: [...await keychainToolCommand(), ...args],
		env,
		stdin: input === undefined ? "null" : "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	if (input !== undefined) {
		const writer = child.stdin.getWriter();
		await writer.write(new TextEncoder().encode(input));
		await writer.close();
	}
	const output = await child.output();
	const decoder = new TextDecoder();
	return {
		code: output.code,
		stdout: decoder.decode(output.stdout).trim(),
		stderr: decoder.decode(output.stderr).trim(),
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await Deno.stat(path);
		return true;
	} catch {
		return false;
	}
}
