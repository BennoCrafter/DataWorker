/**
 * Server status and the component setup: fetches /api/status, keeps the top-chrome status pill
 * and brand current, and (components feature) runs the first-launch component download with
 * progress in the activity popover.
 */
import { $, postStream } from "./util.js";
import { activityDone, activityError, activityProgress, activityStart } from "./activity.js";

/** The last /api/status snapshot — includes `features` so the UI knows what is enabled. */
export let appStatus = { features: {} };

/** A short java label like "openjdk 25.0.3 LTS · embedded" out of the raw `java -version` line. */
export function javaLabel(status) {
	if (!status.java) return null;
	const versionMatch = String(status.java).match(/"([^"]+)"/);
	const lts = /\bLTS\b/.test(status.java) ? " LTS" : "";
	const source = status.javaSource === "embedded" ? " · embedded" : status.javaSource === "system" ? " · system" : "";
	return (versionMatch ? `openjdk ${versionMatch[1]}${lts}` : status.java) + source;
}

export function applyStatusLabels(status) {
	appStatus = status;
	if (status.name) {
		$("brand-name").textContent = status.name;
		document.title = status.name;
	}
	if (status.version) document.querySelector("#topbar .brand").title = `build ${status.version}`;
}

/** Re-fetches /api/status and refreshes the top-chrome labels. */
export async function refreshStatus() {
	try {
		const status = await (await fetch("/api/status")).json();
		applyStatusLabels(status);
		return status;
	} catch {
		return null;
	}
}

/**
 * COMPONENTS FEATURE: downloads whatever component is missing, with progress in the activity
 * popover. Resolves to true when everything is in place afterwards; on failure the activity
 * shows the error and false is returned (the caller decides whether to open Settings for
 * credentials).
 */
export async function ensureComponents() {
	activityStart("Component Setup", "Downloading components…");
	const result = await postStream("/api/components/ensure", {}, activityProgress);
	if (result.ok === false) {
		activityError(result.error ?? "component setup failed");
		return false;
	}
	activityDone(null, result.installed?.length ? `Downloaded: ${result.installed.join(", ")}` : "Everything in place");
	await refreshStatus();
	return true;
}
