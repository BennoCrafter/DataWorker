/**
 * Server status: fetches /api/status and keeps the top-chrome brand/title current.
 */
import { $ } from "./util.js";
import { t } from "./i18n.js";

/** The last /api/status snapshot — includes `features` so the UI knows what is enabled. */
export let appStatus = { features: {} };

export function applyStatusLabels(status) {
	appStatus = status;
	if (status.name) {
		$("brand-name").textContent = status.name;
		document.title = status.name;
	}
	if (status.version) document.querySelector("#topbar .brand").title = t("status.buildTooltip", { version: status.version });
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
