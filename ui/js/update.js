/**
 * UPDATES FEATURE: in-app updates — the app and (components feature) the downloaded
 * components, always behind a button: a background check against the published manifests shows
 * the header Update button when anything newer exists; clicking it downloads and installs with
 * real progress in the activity popover. Component updates take effect in place; an installed
 * APP update waits for the user — the header button turns into "Restart" and the activity card
 * offers "Restart Now". Only that explicit restart quits this instance (the server kills the
 * process) and starts the new one.
 */
import { $, el, lucideIcon, postJson, postStream, refreshIcons } from "./util.js";
import { activityDone, activityError, activityProgress, activityStart } from "./activity.js";
import { refreshStatus } from "./status.js";

/** GET /api/update — {app, components, available, pendingRestart}, or null when unreachable. */
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
	for (const component of check?.components ?? []) {
		if (component.available) parts.push(`${component.label} ${component.latest ?? ""}`.trim());
	}
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
		"Update",
		`Update available: ${parts.join(", ")} — downloads and installs`,
		() => applyUpdates(),
	);
}

/** The installed app update waits for the user — the header button becomes "Restart". */
export function showRestartButton(version) {
	setHeaderButton(
		"refresh-cw",
		"Restart",
		version ? `Update to build ${version} installed — restart to finish` : "Restart to finish the update",
		() => restartNow(),
	);
}

/** Quits this instance and starts the updated app — on explicit user request only. */
export function restartNow() {
	$("update-btn").disabled = true;
	activityStart("App Update", "Restarting…");
	// the process dies moments after the response; if something goes wrong, say so
	postJson("/api/restart", {}).then((result) => {
		if (result.ok === false) {
			activityError(result.error ?? "restart failed");
			$("update-btn").disabled = false;
		}
	});
}

/** Runs /api/update/apply with activity progress; an app update then offers the restart. */
export async function applyUpdates() {
	const button = $("update-btn");
	button.disabled = true;
	activityStart("App Update", "Downloading updates…");
	const result = await postStream("/api/update/apply", {}, activityProgress);
	if (result.ok === false) {
		activityError(result.error ?? "update failed");
		button.disabled = false;
		return result;
	}
	if (result.restartRequired) {
		// installed on disk; this instance keeps running until the user restarts
		showRestartButton(result.version);
		activityDone(null, `Update to build ${result.version} installed — restart when it suits you.`, {
			label: "Restart Now",
			hint: "Ready",
			run: restartNow,
		});
		return result;
	}
	activityDone(null, result.updated?.length ? `Updated: ${result.updated.join(", ")}` : "Everything up to date");
	button.classList.add("hidden");
	await refreshStatus();
	return result;
}

/** Background check at boot — shows the header Update button when something newer is published. */
export async function initUpdate() {
	const check = await fetchUpdateCheck();
	if (check?.pendingRestart) showRestartButton(check.pendingRestart);
	else if (check?.available) showUpdateButton(check);
}
