/**
 * Authenticated access to an artifact repository (Artifactory-style): plain requests first,
 * then credential candidates — environment variables, and (when the keychain feature is on)
 * the keychain. Shared by the component downloads (components.ts), the in-app updater
 * (update.ts) and the publisher (scripts/publish.ts, uploads).
 *
 * Credential environment variables, in order (app-prefixed first, then the denkbares/
 * Artifactory conventions for compatibility with existing tooling):
 *
 *   <PREFIX>_REPO_AUTHORIZATION / DENKBARES_REPO_AUTHORIZATION / ARTIFACTORY_AUTHORIZATION
 *       a complete Authorization header value ("Bearer …" / "Basic …")
 *   <PREFIX>_REPO_TOKEN / DENKBARES_REPO_TOKEN / ARTIFACTORY_TOKEN / REPO_TOKEN
 *       a bare token (tried as Bearer and X-JFrog-Art-Api) or "user:password"
 *   <PREFIX>_REPO_USER + <PREFIX>_REPO_PASSWORD (and the DENKBARES_/ARTIFACTORY_/REPO_ forms)
 *       basic auth
 */

import { crypto } from "@std/crypto";
import { APP, keychainEnabled } from "../app.config.ts";
import type { KeychainSnapshot } from "./keychain.ts";

export type DownloadInfo = {
	url: string;
	authenticated: boolean;
};

export type DownloadProgress = (received: number, total: number | null) => void;

type RepoInit = {
	method?: string;
	headers?: Record<string, string>;
	body?: Uint8Array<ArrayBuffer>;
};

type Credentials = {
	headers: Record<string, string>;
};

export async function fetchText(url: string): Promise<{ text: string; info: DownloadInfo }> {
	const { response, info } = await fetchAuthenticated(url);
	return { text: await response.text(), info };
}

/** Downloads `url` to `target` (written next to it, then renamed), reporting received bytes. */
export async function downloadFile(url: string, target: string, onProgress?: DownloadProgress): Promise<DownloadInfo> {
	const { response, info } = await fetchAuthenticated(url);
	await Deno.mkdir(dirname(target), { recursive: true });
	const temp = `${target}.download`;
	const file = await Deno.open(temp, { create: true, write: true, truncate: true });
	const total = contentLength(response);
	let received = 0;
	try {
		if (!response.body) throw new Error(`empty response body while downloading ${url}`);
		for await (const chunk of response.body) {
			let written = 0;
			while (written < chunk.length) written += await file.write(chunk.subarray(written));
			received += chunk.length;
			onProgress?.(received, total);
		}
		file.close();
		await Deno.rename(temp, target);
	} catch (error) {
		try {
			file.close();
		} catch {
			// already closed
		}
		await Deno.remove(temp).catch(() => {});
		throw error;
	}
	return info;
}

/** PUTs `data` to `url` (Artifactory deploy — same path overwrites); throws unless 2xx. */
export async function uploadFile(
	url: string,
	data: Uint8Array<ArrayBuffer>,
	headers: Record<string, string> = {},
): Promise<DownloadInfo> {
	const { response, info } = await fetchAuthenticated(url, { method: "PUT", headers, body: data });
	await response.body?.cancel();
	return info;
}

export async function fetchAuthenticated(
	url: string,
	init: RepoInit = {},
): Promise<{ response: Response; info: DownloadInfo }> {
	const request = (extra: Record<string, string> = {}) =>
		fetch(url, { method: init.method ?? "GET", headers: { ...init.headers, ...extra }, body: init.body });

	const plain = await request();
	if (plain.ok) return { response: plain, info: { url, authenticated: false } };
	if (plain.status !== 401 && plain.status !== 403) throw await httpError(url, plain);
	await plain.body?.cancel();

	const credentials = await credentialCandidates(url);
	for (const credential of credentials) {
		const response = await request(credential.headers);
		if (response.ok) return { response, info: { url, authenticated: true } };
		if (response.status !== 401 && response.status !== 403) throw await httpError(url, response);
		await response.body?.cancel();
	}

	throw new Error(
		`Authentication failed for ${url}. Provide repository credentials via the environment` +
			(keychainEnabled() ? " or a keychain entry matching the URL (see Settings)." : "."),
	);
}

// ---------------------------------------------------------------------------
// credentials — environment, keychain
// ---------------------------------------------------------------------------

function firstEnv(names: string[]): string | undefined {
	for (const name of names) {
		const value = Deno.env.get(name);
		if (value) return value;
	}
	return undefined;
}

const AUTHORIZATION_VARS = () => [
	`${APP.envPrefix}_REPO_AUTHORIZATION`,
	"DENKBARES_REPO_AUTHORIZATION",
	"ARTIFACTORY_AUTHORIZATION",
];
const TOKEN_VARS = () => [
	`${APP.envPrefix}_REPO_TOKEN`,
	"DENKBARES_REPO_TOKEN",
	"ARTIFACTORY_TOKEN",
	"REPO_TOKEN",
];
const USER_VARS = () => [
	`${APP.envPrefix}_REPO_USER`,
	"DENKBARES_REPO_USER",
	"ARTIFACTORY_USER",
	"ARTIFACTORY_USERNAME",
	"REPO_USER",
];
const PASSWORD_VARS = () => [
	`${APP.envPrefix}_REPO_PASSWORD`,
	"DENKBARES_REPO_PASSWORD",
	"ARTIFACTORY_PASSWORD",
	"REPO_PASSWORD",
];

/** Where a download for `url` would get its credentials from — for the Settings popover. */
export async function credentialStatus(
	url: string,
): Promise<{ source: "environment" | "keychain" | "none"; detail?: string }> {
	for (const name of [...AUTHORIZATION_VARS(), ...TOKEN_VARS()]) {
		if (Deno.env.get(name)) return { source: "environment", detail: name };
	}
	const envUser = firstEnv(USER_VARS());
	if (envUser) return { source: "environment", detail: `user ${envUser}` };

	const snapshot = await keychainSnapshotIfEnabled(url);
	if (snapshot?.token) return { source: "keychain", detail: mask(snapshot.token) };
	if (snapshot?.userPassword) {
		return { source: "keychain", detail: `user ${parseCredentialValue(snapshot.userPassword)?.user ?? "?"}` };
	}

	return { source: "none" };
}

function mask(secret: string): string {
	return secret.length <= 10 ? "•••" : `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

async function credentialCandidates(url: string): Promise<Credentials[]> {
	const credentials: Credentials[] = [];

	const authorization = firstEnv(AUTHORIZATION_VARS());
	if (authorization) credentials.push({ headers: { Authorization: authorization } });

	const envToken = firstEnv(TOKEN_VARS());
	if (envToken) credentials.push(...valueCredentials(envToken));

	const snapshot = await keychainSnapshotIfEnabled(url);
	if (snapshot?.token) credentials.push(...tokenCredentials(snapshot.token));

	const envUser = firstEnv(USER_VARS());
	const envPassword = firstEnv(PASSWORD_VARS());
	if (envUser && envPassword) credentials.push(basicCredentials(envUser, envPassword));

	if (snapshot?.userPassword) {
		const parsed = parseCredentialValue(snapshot.userPassword);
		if (parsed) credentials.push(basicCredentials(parsed.user, parsed.password));
	}

	return credentials;
}

/**
 * The keychain's credentials for `url` via ONE (cached) helper run — only when the keychain
 * feature is on; the module is loaded lazily so a disabled feature costs nothing.
 */
async function keychainSnapshotIfEnabled(url: string): Promise<KeychainSnapshot | null> {
	if (!keychainEnabled()) return null;
	try {
		const { keychainSnapshot } = await import("./keychain.ts");
		return await keychainSnapshot(url);
	} catch {
		return null; // any failure just means "no candidate from here"
	}
}

function parseCredentialValue(value: string): { user: string; password: string } | null {
	const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (lines.length >= 2) return { user: lines[0], password: lines.slice(1).join("\n") };

	const colon = value.indexOf(":");
	if (colon > 0) return { user: value.slice(0, colon), password: value.slice(colon + 1) };

	return null;
}

/** Credentials for a secret that is either a token or a "user:password" pair. */
function valueCredentials(value: string): Credentials[] {
	if (value.includes(":") && !/^(Bearer|Basic)\s+/i.test(value)) {
		const parsed = parseCredentialValue(value);
		return parsed ? [basicCredentials(parsed.user, parsed.password)] : [];
	}
	return tokenCredentials(value);
}

function tokenCredentials(token: string): Credentials[] {
	if (/^(Bearer|Basic)\s+/i.test(token)) return [{ headers: { Authorization: token } }];
	if (token.includes(":")) return [];
	return [
		{ headers: { Authorization: `Bearer ${token}` } },
		{ headers: { "X-JFrog-Art-Api": token } },
	];
}

function basicCredentials(user: string, password: string): Credentials {
	return {
		headers: { Authorization: `Basic ${btoa(`${user}:${password}`)}` },
	};
}

async function httpError(url: string, response: Response): Promise<Error> {
	const body = await response.text().catch(() => "");
	const suffix = body.trim() ? `: ${body.trim().slice(0, 300)}` : "";
	return new Error(`Download failed for ${url}: HTTP ${response.status} ${response.statusText}${suffix}`);
}

function contentLength(response: Response): number | null {
	const value = Number(response.headers.get("content-length"));
	return Number.isFinite(value) && value > 0 ? value : null;
}

export async function fileSha256(path: string): Promise<string> {
	const file = await Deno.open(path, { read: true });
	const digest = await crypto.subtle.digest("SHA-256", file.readable);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dirname(path: string): string {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "." : path.slice(0, index);
}
