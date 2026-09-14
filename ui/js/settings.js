/**
 * The Settings popover: build/version info, the theme toggle, and — per enabled feature —
 * the Java runtime row, a manual update check, the installed components, and the keychain
 * (on macOS the keychain's unlock password, kept in the login Keychain so it survives a
 * Finder launch; on Linux the password comes from DES_KEYCHAIN_PW), plus a read-only
 * indicator of where repository credentials come from.
 *
 * The sections adapt to /api/settings, which itself adapts to app.config.ts — a disabled
 * feature simply has no data and renders nothing. ADD YOUR APP'S SECTIONS in renderSettings.
 */
import { $, el, lucideIcon, postJson, refreshIcons, shortPath } from "./util.js";
import { config, currentTheme, saveConfig } from "./config.js";
import { state } from "./state.js";
import { ensureComponents } from "./status.js";
import {
	applyUpdates,
	fetchUpdateCheck,
	restartNow,
	showRestartButton,
	showUpdateButton,
	updateSummary,
} from "./update.js";

let data = null; // /api/settings snapshot, fetched when the popover opens
let updateCheck; // /api/update result of the manual check (undefined = not checked)
let checking = false; // the manual update check is running
let busy = false; // a save/check is running — buttons disabled
let messages = {}; // section key -> {text, tone: "ok"|"error"|"info"}
let draft = { password: "" }; // keychain-password input, preserved across re-renders
let pendingFocus = false; // focus the keychain-password field on the next render (first-run prompt)

export function initSettings() {
	$("settings-btn").onclick = (event) => {
		event.stopPropagation();
		if (state.showSettings) closeSettings();
		else openSettings();
	};
}

export function openSettings() {
	state.showSettings = true;
	messages = {};
	updateCheck = undefined;
	draft = { password: "" };
	pendingFocus = false;
	renderSettings();
	refreshSettings();
}

export function closeSettings() {
	state.showSettings = false;
	pendingFocus = false;
	renderSettings();
}

/**
 * First-run guidance when the app can't authenticate yet (components feature): open Settings
 * and point the user at what's missing. With the keychain feature the keychain section states
 * the precise situation per OS; this adds a prominent prompt (and, on macOS, focuses the
 * password field).
 */
export function promptSetup(settings) {
	openSettings();
	const keychain = settings?.keychain;
	if (keychain && !keychain.passwordSource) {
		if (keychain.canStorePassword) {
			messages.keychain = {
				text: "Set a keychain password to unlock your keychain and read the repository credentials.",
				tone: "info",
			};
			pendingFocus = true;
		} else {
			messages.keychain = {
				text: "No keychain password available — set DES_KEYCHAIN_PW in your environment, then reopen the app.",
				tone: "error",
			};
		}
	} else {
		messages.repo = {
			text: "No repository credentials found — set them in your environment (see the README), then reopen the app.",
			tone: "error",
		};
	}
	renderSettings();
}

async function refreshSettings() {
	try {
		data = await (await fetch("/api/settings")).json();
	} catch {
		data = null;
	}
	renderSettings();
}

export function renderSettings() {
	const pop = $("settings-pop");
	pop.classList.toggle("hidden", !state.showSettings);
	if (!state.showSettings) return;
	pop.replaceChildren();

	const head = el("div", "pop-head");
	head.append(el("div", "text-subheadline emphasized", "Settings"));
	head.append(themeToggle());
	pop.append(head);

	if (!data) {
		pop.append(note("Loading…"));
		refreshIcons();
		return;
	}

	const sections = [
		appSection(),
		componentsSection(),
		keychainSection(),
		// ── your app's sections here ──
	];
	for (const section of sections) {
		if (section) pop.append(section);
	}
	refreshIcons();
}

// --- App ------------------------------------------------------------------------------------

function appSection() {
	const section = sectionEl("App");
	section.append(
		row("Version", data.version ? `${data.version}${data.commit ? ` (${data.commit})` : ""}` : "running from source"),
		row("Platform", data.platform),
	);
	if (data.features?.java) {
		section.append(row(
			"Java",
			data.javaProblem ?? (data.java ? shortJava(data.java) + sourceSuffix(data.javaSource) : "not available"),
			data.javaProblem ? "error" : "",
		));
	}
	for (const warning of data.warnings ?? []) {
		section.append(el("div", "text-caption1 set-message error", warning));
	}

	if (data.features?.updates) {
		const actions = el("div", "set-actions");
		const check = button("Check for Updates", async () => {
			messages.update = null;
			checking = true;
			renderSettings();
			const result = await fetchUpdateCheck();
			checking = false;
			updateCheck = result;
			if (!result) messages.update = { text: "The repository is not reachable.", tone: "error" };
			else if (result.pendingRestart) {
				messages.update = { text: "An update is already installed — restart to finish.", tone: "ok" };
				showRestartButton(result.pendingRestart);
			} else if (!result.available) {
				// "up to date" only when the checks actually succeeded — a failed check is not a result
				const problems = [
					result.app?.error,
					...(result.components ?? []).map((c) => c.error ? `${c.label}: ${c.error}` : null),
				].filter(Boolean);
				messages.update = problems.length === 0
					? { text: "Everything is up to date.", tone: "ok" }
					: problems.some((p) => p.includes("Authentication failed"))
					? { text: "The update check could not authenticate — see the credentials section below.", tone: "error" }
					: { text: `The update check failed: ${problems[0]}`, tone: "error" };
			}
			if (result?.available && !result?.pendingRestart) showUpdateButton(result);
			renderSettings();
		});
		actions.append(check);
		if (checking) actions.append(note("Checking…"));
		if (updateCheck?.pendingRestart) {
			actions.append(button("Restart Now", () => {
				closeSettings();
				restartNow();
			}, "filled"));
		} else if (updateCheck?.available) {
			actions.append(button("Install", () => {
				closeSettings();
				applyUpdates();
			}, "filled"));
		}
		section.append(actions);
		if (updateCheck?.available && !updateCheck?.pendingRestart) {
			section.append(note(`Available: ${updateSummary(updateCheck).join(", ")}`));
		}
		appendMessage(section, "update");
	}
	return section;
}

// --- Theme ----------------------------------------------------------------------------------

/** Applies the configured theme to the document. */
export function applyTheme() {
	document.documentElement.dataset.theme = currentTheme();
}

/** Switches the theme — behind the sun/moon toggle here and the macOS menu's Appearance. */
export function setTheme(mode) {
	config.theme = mode;
	saveConfig();
	applyTheme();
	renderSettings();
}

/** Sun/moon theme switch in the popover's top-right corner — icons only, no label. */
function themeToggle() {
	const seg = el("div", "segmented");
	seg.style.marginLeft = "auto";
	seg.style.height = "28px";
	for (const [mode, icon, label] of [["light", "sun", "Light"], ["dark", "moon", "Dark"]]) {
		const button = el("button");
		button.title = label;
		button.style.height = "24px";
		button.style.padding = "0 10px";
		// center the icon: text-align does not center the flex-display <i> the helper returns
		button.style.display = "flex";
		button.style.alignItems = "center";
		button.style.justifyContent = "center";
		button.classList.toggle("active", currentTheme() === mode);
		button.append(lucideIcon(icon, 14));
		button.onclick = () => setTheme(mode);
		seg.append(button);
	}
	return seg;
}

function shortJava(java) {
	const versionMatch = String(java).match(/"([^"]+)"/);
	return versionMatch ? `openjdk ${versionMatch[1]}` : java;
}

function sourceSuffix(source) {
	return source === "embedded" ? " · embedded" : source === "system" ? " · system" : "";
}

// --- Components (components feature) ---------------------------------------------------------

function componentsSection() {
	if (!data.features?.components) return null;
	const components = Object.entries(data.components ?? {});
	if (components.length === 0) return null; // feature on, but nothing registered yet
	const section = sectionEl("Components");
	for (const [name, version] of components) {
		section.append(row(name, version ?? "not downloaded", version ? "" : "error"));
	}
	if (!data.componentsReady) {
		const actions = el("div", "set-actions");
		actions.append(button("Download Missing Components", () => {
			closeSettings();
			ensureComponents().then((ok) => {
				if (!ok) openSettings();
			});
		}, "filled"));
		section.append(actions);
	}
	return section;
}

// --- Keychain (keychain feature) --------------------------------------------------------------

// The app never sets repository credentials — they must already be in the keychain (managed
// with KeychainCLI). This section manages the keychain's unlock password (macOS) and reports
// where credentials come from.
function keychainSection() {
	if (!data.features?.keychain) return repoSection(); // credentials still matter for downloads
	const keychain = data.keychain ?? {};
	const section = sectionEl("Keychain");

	// 1. unlock-password status
	if (keychain.passwordSource === "environment") {
		section.append(statusLine("green", "Unlocked — password from the environment (DES_KEYCHAIN_PW)"));
	} else if (keychain.managed && keychain.unlocked) {
		section.append(statusLine("green", "Unlocked — password stored in the macOS Keychain"));
	} else if (keychain.managed && !keychain.unlocked) {
		section.append(statusLine("red", keychain.error ?? "The stored password no longer opens the keychain"));
	} else if (keychain.canStorePassword) {
		section.append(statusLine("gray", "Locked — set the keychain password to read the credentials"));
	} else {
		section.append(statusLine("gray", "Locked — set DES_KEYCHAIN_PW in your environment to read the credentials"));
	}
	if (keychain.file) section.append(note(shortPath(keychain.file)));

	// 2. macOS: set / change / clear the stored unlock password
	if (keychain.canStorePassword) {
		const password = el("input", "set-input");
		password.type = "password";
		password.placeholder = keychain.managed ? "Change keychain password" : "Keychain password";
		password.autocomplete = "off";
		password.value = draft.password;
		password.oninput = () => draft.password = password.value;
		if (pendingFocus) {
			pendingFocus = false;
			setTimeout(() => password.focus(), 0);
		}
		const actions = el("div", "set-actions");
		actions.append(button(keychain.managed ? "Change" : "Set", async () => {
			if (!password.value.trim()) return message("keychain", "Enter a password first.", "error");
			await run(async () => {
				const result = await postJson("/api/settings/keychain-password", { password: password.value });
				if (!result.ok) return message("keychain", result.error ?? "saving the password failed", "error");
				draft.password = "";
				messages.keychain = { text: "Keychain password saved.", tone: "ok" };
				await refreshSettings();
				// a freshly unlocked keychain may hold the credentials needed to finish setup
				if (data?.features?.components && !data?.componentsReady && data?.repo?.source !== "none") {
					closeSettings();
					const ok = await ensureComponents();
					if (!ok) openSettings();
				}
			});
		}));
		if (keychain.managed) {
			actions.append(button("Clear", async () => {
				await run(async () => {
					const result = await postJson("/api/settings/keychain-password", { password: "" });
					if (!result.ok) return message("keychain", result.error ?? "clearing failed", "error");
					messages.keychain = { text: "Keychain password cleared.", tone: "ok" };
					await refreshSettings();
				});
			}, "ghost"));
		}
		const form = el("div", "set-form");
		form.append(password, actions);
		section.append(form);
	}
	appendMessage(section, "keychain");

	// 3. credential presence — the app reads credentials, it does not set them
	appendRepoStatus(section, true);
	return section;
}

/** Credentials-only section when downloads are on but the keychain feature is off. */
function repoSection() {
	if (!data.repo) return null;
	const section = sectionEl("Repository Credentials");
	appendRepoStatus(section, false);
	appendMessage(section, "repo");
	return section;
}

function appendRepoStatus(section, separated) {
	const repo = data.repo ?? { source: "none" };
	const line = (color, text) => {
		const status = statusLine(color, text);
		if (separated) {
			status.style.marginTop = "10px";
			status.style.paddingTop = "10px";
			status.style.borderTop = "var(--separator-height) solid var(--separator)";
		}
		return status;
	};
	if (repo.source === "keychain") {
		section.append(line("green", `Repository credentials found in the keychain (${repo.detail ?? "…"})`));
	} else if (repo.source === "environment") {
		section.append(line("green", `Repository credentials from the environment (${repo.detail ?? "?"})`));
	} else if (data.features?.keychain && !data.keychain?.unlocked) {
		section.append(line("gray", "Repository credentials: unknown until the keychain is unlocked"));
	} else {
		section.append(line("red", "No repository credentials found"));
		section.append(note(
			data.features?.keychain
				? "Add them with KeychainCLI under a key matching the repository URL — downloads need them."
				: "Set them in the environment (see the README) — downloads need them.",
		));
	}
}

// --- building blocks ------------------------------------------------------------------------

function sectionEl(title) {
	const section = el("div", "set-section");
	section.append(el("div", "text-caption1 emphasized set-title", title));
	return section;
}

function row(label, value, tone = "") {
	const line = el("div", "set-row");
	line.append(el("span", "text-caption1 set-label", label), el("span", `text-caption1 set-value ${tone}`, value));
	return line;
}

function statusLine(color, text) {
	const line = el("div", "set-status");
	const dot = el("span", "dot");
	dot.style.background = color === "gray" ? "var(--gray)" : `var(--color-${color})`;
	line.append(dot, el("span", "text-caption1", text));
	return line;
}

function note(text) {
	return el("div", "text-caption1 set-note", text);
}

function button(label, onClick, style = "ghost") {
	const node = el(
		"button",
		`${style === "filled" ? "btn-filled" : "btn-ghost"} text-footnote emphasized set-btn`,
		label,
	);
	node.disabled = busy;
	node.onclick = onClick;
	return node;
}

function message(key, text, tone) {
	messages[key] = { text, tone };
	renderSettings();
}

function appendMessage(section, key) {
	const entry = messages[key];
	if (entry) section.append(el("div", `text-caption1 set-message ${entry.tone}`, entry.text));
}

/** Wraps an async action: buttons disabled while it runs, popover re-rendered afterwards. */
async function run(action) {
	busy = true;
	renderSettings();
	try {
		await action();
	} finally {
		busy = false;
		renderSettings();
	}
}
