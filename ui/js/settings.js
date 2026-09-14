/**
 * The Settings popover: build/version info, the language + theme toggles, and a manual update
 * check. ADD YOUR APP'S SECTIONS in renderSettings.
 */
import { $, el, lucideIcon, refreshIcons } from "./util.js";
import { config, currentTheme, saveConfig } from "./config.js";
import { state } from "./state.js";
import { currentLanguage, onLanguageChange, setLanguage, t } from "./i18n.js";
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
let messages = {}; // section key -> {text, tone: "ok"|"error"|"info"}

export function initSettings() {
	$("settings-btn").onclick = (event) => {
		event.stopPropagation();
		if (state.showSettings) closeSettings();
		else openSettings();
	};
	onLanguageChange(() => renderSettings());
}

export function openSettings() {
	state.showSettings = true;
	messages = {};
	updateCheck = undefined;
	renderSettings();
	refreshSettings();
}

export function closeSettings() {
	state.showSettings = false;
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
	head.append(el("div", "text-subheadline emphasized", t("settings.title")));
	head.append(languageToggle());
	head.append(themeToggle());
	pop.append(head);

	if (!data) {
		pop.append(note(t("settings.loading")));
		refreshIcons();
		return;
	}

	const sections = [
		appSection(),
		// ── your app's sections here ──
	];
	for (const section of sections) {
		if (section) pop.append(section);
	}
	refreshIcons();
}

// --- App ------------------------------------------------------------------------------------

function appSection() {
	const section = sectionEl(t("settings.appSection"));
	section.append(
		row(t("settings.version"), data.version ? `${data.version}${data.commit ? ` (${data.commit})` : ""}` : t("settings.runningFromSource")),
		row(t("settings.platform"), data.platform),
	);
	for (const warning of data.warnings ?? []) {
		section.append(el("div", "text-caption1 set-message error", warning));
	}

	if (data.features?.updates) {
		const actions = el("div", "set-actions");
		const check = button(t("settings.checkForUpdates"), async () => {
			messages.update = null;
			checking = true;
			renderSettings();
			const result = await fetchUpdateCheck();
			checking = false;
			updateCheck = result;
			if (!result) messages.update = { text: t("settings.repoUnreachable"), tone: "error" };
			else if (result.pendingRestart) {
				messages.update = { text: t("settings.restartToFinish"), tone: "ok" };
				showRestartButton(result.pendingRestart);
			} else if (!result.available) {
				// "up to date" only when the check actually succeeded — a failed check is not a result
				const problems = [result.app?.error].filter(Boolean);
				messages.update = problems.length === 0
					? { text: t("settings.upToDate"), tone: "ok" }
					: problems.some((p) => p.includes("Authentication failed"))
					? { text: t("settings.authFailed"), tone: "error" }
					: { text: t("settings.checkFailed", { reason: problems[0] }), tone: "error" };
			}
			if (result?.available && !result?.pendingRestart) showUpdateButton(result);
			renderSettings();
		});
		actions.append(check);
		if (checking) actions.append(note(t("settings.checking")));
		if (updateCheck?.pendingRestart) {
			actions.append(button(t("settings.restartNow"), () => {
				closeSettings();
				restartNow();
			}, "filled"));
		} else if (updateCheck?.available) {
			actions.append(button(t("settings.install"), () => {
				closeSettings();
				applyUpdates();
			}, "filled"));
		}
		section.append(actions);
		if (updateCheck?.available && !updateCheck?.pendingRestart) {
			section.append(note(t("settings.available", { list: updateSummary(updateCheck).join(", ") })));
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

/** DE/EN language switch in the popover's top-right corner, beside the theme toggle. */
function languageToggle() {
	const seg = el("div", "segmented");
	seg.style.marginLeft = "auto";
	seg.style.height = "28px";
	for (const lang of ["de", "en"]) {
		const button = el("button", "text-caption1 emphasized", lang.toUpperCase());
		button.style.height = "24px";
		button.style.padding = "0 10px";
		button.classList.toggle("active", currentLanguage() === lang);
		button.onclick = () => setLanguage(lang);
		seg.append(button);
	}
	return seg;
}

/** Sun/moon theme switch in the popover's top-right corner — icons only, no label. */
function themeToggle() {
	const seg = el("div", "segmented");
	seg.style.marginLeft = "8px";
	seg.style.height = "28px";
	for (const [mode, icon, label] of [["light", "sun", t("theme.light")], ["dark", "moon", t("theme.dark")]]) {
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

function note(text) {
	return el("div", "text-caption1 set-note", text);
}

function button(label, onClick, style = "ghost") {
	const node = el(
		"button",
		`${style === "filled" ? "btn-filled" : "btn-ghost"} text-footnote emphasized set-btn`,
		label,
	);
	node.onclick = onClick;
	return node;
}

function appendMessage(section, key) {
	const entry = messages[key];
	if (entry) section.append(el("div", `text-caption1 set-message ${entry.tone}`, entry.text));
}
