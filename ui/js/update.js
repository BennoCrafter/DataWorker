/**
 * UPDATES FEATURE: in-app self-update, always behind a button: a background check against the
 * published manifest shows the header Update button when a newer build exists; clicking it
 * downloads and installs with real progress in the activity popover, then the header button
 * turns into "Restart" and the activity card offers "Restart Now". Only that explicit restart
 * quits this instance (the server kills the process) and starts the new one.
 */
import { $, el, lucideIcon, postJson, postStream, refreshIcons } from "./util.js";
import { activityDone, activityError, activityProgress, activityStart } from "./activity.js";
import { refreshStatus } from "./status.js";
import { t } from "./i18n.js";

/** GET /api/update — {app, available, pendingRestart}, or null when unreachable. */
export async function fetchUpdateCheck() {
	try {
		const check = await (await fetch("/api/update")).json();
		return check?.ok ? check : null;
	} catch {
		return null;
	}
}

/** Human-readable list of what an update would install. */
export function updateSummary(check) {
	const parts = [];
	if (check?.app?.available) parts.push(`app build ${check.app.latest.version}`);
	return parts;
}

function setHeaderButton(icon, label, title, onClick) {
	const button = $("update-btn");
	button.replaceChildren(lucideIcon(icon, 15), el("span", "text-footnote emphasized", label));
	button.title = title;
	button.disabled = false;
	button.onclick = onClick;
	button.classList.remove("hidden");
	refreshIcons();
}

export function showUpdateButton(check) {
	const parts = updateSummary(check);
	if (parts.length === 0) {
		$("update-btn").classList.add("hidden");
		return;
	}
	setHeaderButton(
		"arrow-down-circle",
		t("update.headerLabel"),
		t("update.availableTooltip", { list: parts.join(", ") }),
		() => applyUpdates(),
	);
}

/** The installed app update waits for the user — the header button becomes "Restart". */
export function showRestartButton(version) {
	setHeaderButton(
		"refresh-cw",
		t("update.headerRestartLabel"),
		version ? t("update.restartTooltip", { version }) : t("update.restartToFinishTooltip"),
		() => restartNow(),
	);
}

/** Quits this instance and starts the updated app — on explicit user request only. */
export function restartNow() {
	$("update-btn").disabled = true;
	activityStart(t("update.appUpdateTitle"), t("update.restarting"));
	// the process dies moments after the response; if something goes wrong, say so
	postJson("/api/restart", {}).then((result) => {
		if (result.ok === false) {
			activityError(result.error ?? t("update.restartFailed"));
			$("update-btn").disabled = false;
		}
	});
}

/** Runs /api/update/apply with activity progress; an app update then offers the restart. */
export async function applyUpdates() {
	const button = $("update-btn");
	button.disabled = true;
	activityStart(t("update.appUpdateTitle"), t("update.downloading"));
	const result = await postStream("/api/update/apply", {}, activityProgress);
	if (result.ok === false) {
		activityError(result.error ?? t("update.updateFailed"));
		button.disabled = false;
		return result;
	}
	// installed on disk; this instance keeps running until the user restarts
	showRestartButton(result.version);
	activityDone(null, t("update.installedRestartWhenReady", { version: result.version }), {
		label: t("settings.restartNow"),
		hint: t("update.ready"),
		run: restartNow,
	});
	return result;
}

/** Background check at boot — shows the header Update button when something newer is published. */
export async function initUpdate() {
	const check = await fetchUpdateCheck();
	if (check?.pendingRestart) showRestartButton(check.pendingRestart);
	else if (check?.available) showUpdateButton(check);
}
