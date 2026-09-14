/**
 * Activity feedback for long-running server work (component setup, updates, your app's own
 * jobs): the top-chrome button + popover with a real progress bar. Feed it from postStream()
 * via activityProgress; activityDone can attach an output path (offered with a Reveal button —
 * the server only reveals paths it produced, see server/system.ts) or a follow-up action
 * ({label, hint, run}, e.g. the update restart).
 */
import { $, dirName, el, postJson } from "./util.js";
import { state } from "./state.js";

export function activityStart(title, message) {
	// pct is 0..1 (null = indeterminate) — driven by real progress via activityProgress()
	state.activity = { phase: "running", pct: null, message: message ?? "", title, output: null, action: null };
	state.showActivity = true;
	renderActivity();
}

export function activityProgress(event) {
	if (state.activity.phase !== "running") return;
	if (typeof event.pct === "number") state.activity.pct = event.pct;
	if (event.message) state.activity.message = event.message;
	renderActivity();
}

/** `action` ({label, hint, run}) renders as a button in the done card — e.g. the update restart. */
export function activityDone(output, message, action = null) {
	state.activity = {
		phase: "done",
		pct: 1,
		message: message ?? "",
		title: state.activity.title,
		output,
		action,
	};
	renderActivity();
}

export function activityError(message) {
	state.activity = {
		phase: "error",
		pct: 0,
		message: String(message),
		title: state.activity.title,
		output: null,
		action: null,
	};
	state.showActivity = true;
	renderActivity();
}

export function renderActivity() {
	const a = state.activity;
	// this app has nothing to report when idle — only take up topbar space while there's an
	// actual update in progress, done, or failed (or the user explicitly reopened the popover)
	$("activity-wrap").classList.toggle("hidden", a.phase === "idle" && !state.showActivity);
	const button = $("activity-btn");
	button.replaceChildren();
	const dot = el("span", "dot");
	const label = el("span", "label text-footnote emphasized");
	const pct = el("span", "pct text-caption1");
	if (a.phase === "running") {
		dot.style.background = "var(--color-accent)";
		dot.style.boxShadow = "0 0 0 3px color-mix(in srgb, var(--color-accent) 22%, transparent)";
		label.textContent = a.title;
		pct.textContent = typeof a.pct === "number" ? Math.round(a.pct * 100) + "%" : "";
	} else if (a.phase === "done") {
		dot.style.background = "var(--color-green)";
		dot.style.boxShadow = "0 0 0 3px color-mix(in srgb, var(--color-green) 22%, transparent)";
		label.textContent = a.title;
		pct.textContent = "100%";
	} else if (a.phase === "error") {
		dot.style.background = "var(--color-red)";
		dot.style.boxShadow = "0 0 0 3px color-mix(in srgb, var(--color-red) 22%, transparent)";
		label.textContent = "Failed";
		pct.textContent = "";
	} else {
		dot.style.background = "var(--gray)";
		dot.style.boxShadow = "0 0 0 3px var(--fill-tertiary)";
		label.textContent = "Idle · Ready";
		pct.textContent = "";
	}
	button.append(dot, label, pct);

	const pop = $("activity-pop");
	pop.classList.toggle("hidden", !state.showActivity);
	if (!state.showActivity) return;
	pop.replaceChildren();
	const head = el("div", "pop-head");
	head.append(el("div", "text-subheadline emphasized", a.phase === "idle" ? "Activity" : a.title));
	pop.append(head);
	const sub = el(
		"div",
		"text-caption1 message",
		a.phase === "idle" ? "Nothing running." : (a.message || (a.output ? dirName(a.output) : "")),
	);
	sub.style.color = "var(--label-secondary)";
	sub.style.marginTop = "2px";
	pop.append(sub);

	if (a.phase === "error") {
		const err = el("div", "text-caption1 error", a.message);
		err.style.marginTop = "12px";
		pop.append(err);
		return;
	}

	// real progress bar — indeterminate (animated) until the job reports a percentage
	const bar = el("div", "bar");
	const fill = el("div");
	const done = a.phase === "done";
	if (typeof a.pct === "number") {
		fill.style.width = Math.round(a.pct * 100) + "%";
	} else {
		fill.style.width = "40%";
		fill.classList.add("indeterminate");
	}
	fill.style.background = done ? "var(--color-green)" : "var(--color-accent)";
	bar.append(fill);
	pop.append(bar);

	if (done && a.output) {
		const result = el("div", "result");
		const name = el("span", "text-caption1 name", a.output.split("/").pop());
		name.title = a.output;
		const reveal = el("button", "btn-filled text-footnote emphasized", "Reveal");
		reveal.style.height = "28px";
		reveal.style.padding = "0 12px";
		reveal.onclick = () => {
			postJson("/api/reveal", { path: a.output });
			state.showActivity = false;
			renderActivity();
		};
		result.append(name, reveal);
		pop.append(result);
	}

	// follow-up action of the finished activity (e.g. "Restart Now" after an app update)
	if (done && a.action) {
		const result = el("div", "result");
		const name = el("span", "text-caption1 name", a.action.hint ?? "");
		const button = el("button", "btn-filled text-footnote emphasized", a.action.label);
		button.style.height = "28px";
		button.style.padding = "0 12px";
		button.onclick = (event) => {
			event.stopPropagation();
			a.action.run();
		};
		result.append(name, button);
		pop.append(result);
	}
}
