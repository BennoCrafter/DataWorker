/**
 * PREREQUISITES FEATURE: the startup gate. ensurePrerequisites() resolves immediately when the
 * feature is off (or the server unreachable — fail open) or everything is already installed;
 * otherwise it fills #prereq-layer with a blocking card — one row per requirement — and only
 * resolves once a re-check reports everything present. Re-checks run on the button and on a
 * gentle auto-poll, so installing a tool in a terminal lets the app through without any further
 * clicking. The rest of the app does not boot until then (see main.js).
 *
 * Per failing item the server can supply (see server/prereqs.ts): prose, shell `commands`
 * rendered as code blocks with a copy button, a `link` opened in the real browser (never in
 * this webview), and a `fix` — an input field whose value is POSTed to /api/prereqs/fix so a
 * pasted token is installed without a terminal. Auto-polls skip re-rendering while nothing
 * changed, so typing into a fix field is never interrupted.
 */
import { $, el, lucideIcon, postJson, refreshIcons } from "./util.js";

const POLL_MS = 4000;

async function fetchPrereqs() {
	try {
		const result = await (await fetch("/api/prereqs")).json();
		return result?.ok ? result : null;
	} catch {
		return null;
	}
}

/** Clipboard write, with the execCommand fallback webviews without permission still need. */
async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		try {
			const area = document.createElement("textarea");
			area.value = text;
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.append(area);
			area.select();
			const ok = document.execCommand("copy");
			area.remove();
			return ok;
		} catch {
			return false;
		}
	}
}

/** Blocks until every prerequisite passes; instant when the feature is off or all are met. */
export async function ensurePrerequisites() {
	const first = await fetchPrereqs();
	if (!first || first.satisfied) return;

	await new Promise((resolve) => {
		const layer = $("prereq-layer");
		let latest = first;
		let timer = null;
		let checking = false;
		const drafts = {}; // item.id -> {value, error, busy} for fix forms, kept across renders
		const copied = new Set(); // "id:index" of commands currently showing their copied state

		const finish = () => {
			clearTimeout(timer);
			layer.classList.add("hidden");
			layer.replaceChildren();
			resolve();
		};

		// manual = button click / fix submitted: show the checking state and always re-render.
		// Auto-polls stay silent and only re-render when the items actually changed, so typing
		// into a fix field is not interrupted by the poll.
		const recheck = async (manual = false) => {
			if (checking) return;
			checking = true;
			if (manual) render();
			const result = await fetchPrereqs();
			checking = false;
			if (!result || result.satisfied) return finish();
			const changed = JSON.stringify(result.items) !== JSON.stringify(latest.items);
			latest = result;
			if (manual || changed) render();
			clearTimeout(timer);
			timer = setTimeout(recheck, POLL_MS);
		};

		/** A shell command as a code block with a copy button. */
		const commandBlock = (item, command, index) => {
			const key = `${item.id}:${index}`;
			const block = el("div", "prereq-cmd");
			block.append(el("code", "prereq-cmd-text", command));
			const copy = el("button", "prereq-copy");
			copy.title = "Copy command";
			copy.append(lucideIcon(copied.has(key) ? "check" : "copy", 13));
			copy.onclick = async () => {
				if (!await copyText(command)) return;
				copied.add(key);
				render();
				setTimeout(() => {
					copied.delete(key);
					if (!layer.classList.contains("hidden")) render();
				}, 1500);
			};
			block.append(copy);
			return block;
		};

		/** Opens a page in the user's browser — the webview must not navigate away from the app. */
		const linkButton = (link) => {
			const button = el("button", "prereq-link text-caption1");
			button.append(lucideIcon("external-link", 12), el("span", "", link.label));
			button.onclick = () => postJson("/api/open-url", { url: link.url });
			return button;
		};

		/** The paste-a-value field for items the app can fix itself. */
		const fixForm = (item) => {
			const draft = drafts[item.id] ??= { value: "", error: null, busy: false };
			const box = el("div", "prereq-fix-box");
			const form = el("div", "prereq-fix");
			const input = el("input", "prereq-input");
			// masked unless explicitly "text": these fields carry secrets (tokens, passwords)
			input.type = item.fix.type === "text" ? "text" : "password";
			input.placeholder = item.fix.placeholder ?? "";
			input.autocomplete = "off";
			input.spellcheck = false;
			input.value = draft.value;
			input.disabled = draft.busy;
			input.oninput = () => draft.value = input.value;
			const submit = el(
				"button",
				"btn-filled text-footnote emphasized prereq-btn",
				draft.busy ? "Saving…" : (item.fix.submitLabel ?? "Save"),
			);
			submit.disabled = draft.busy;
			const apply = async () => {
				if (!input.value.trim() || draft.busy) return;
				draft.busy = true;
				draft.error = null;
				render();
				const result = await postJson("/api/prereqs/fix", { id: item.id, value: draft.value });
				draft.busy = false;
				if (result.ok === false) {
					draft.error = result.error ?? "saving failed";
					render();
					return;
				}
				drafts[item.id] = { value: "", error: null, busy: false };
				recheck(true);
			};
			submit.onclick = apply;
			input.onkeydown = (event) => {
				if (event.key === "Enter") apply();
			};
			form.append(input, submit);
			box.append(form);
			if (item.fix.note) box.append(el("div", "text-caption1 prereq-note", item.fix.note));
			if (draft.error) box.append(el("div", "text-caption1 prereq-error", draft.error));
			return box;
		};

		const render = () => {
			layer.replaceChildren();
			layer.classList.remove("hidden");
			const card = el("div", "prereq-card");
			card.append(el("div", "text-title3 emphasized", "Before you start"));
			card.append(el(
				"div",
				"text-subheadline prereq-sub",
				`${document.title} needs a few things set up. Work through what is missing below — ` +
					"the list re-checks by itself.",
			));

			const list = el("div", "prereq-list");
			for (const item of latest.items) {
				const row = el("div", "prereq-row");
				const dot = el("span", "dot");
				dot.style.background = item.ok ? "var(--color-green)" : "var(--color-red)";
				const body = el("div", "prereq-body");
				const head = el("div", "prereq-head");
				head.append(el("span", "text-subheadline emphasized", item.label));
				// a passing item's detail is a short fact (the resolved path) and fits beside the
				// label; a failing one's is the diagnosis and gets its own line below
				if (item.ok && item.detail) head.append(el("span", "text-caption1 prereq-detail", item.detail));
				body.append(head);
				if (!item.ok) {
					if (item.detail) body.append(el("div", "text-caption1 prereq-problem", item.detail));
					body.append(el("div", "text-caption1 prereq-hint", item.hint));
					if (item.link) body.append(linkButton(item.link));
					for (const [index, command] of (item.commands ?? []).entries()) {
						body.append(commandBlock(item, command, index));
					}
					if (item.fix) body.append(fixForm(item));
				}
				row.append(dot, body);
				list.append(row);
			}
			card.append(list);

			const actions = el("div", "prereq-actions");
			const button = el("button", "btn-filled text-footnote emphasized prereq-btn");
			button.append(lucideIcon("refresh-cw", 13), el("span", "", checking ? "Checking…" : "Check Again"));
			button.disabled = checking;
			button.onclick = () => recheck(true);
			actions.append(button);
			card.append(actions);

			layer.append(card);
			refreshIcons(layer);
		};

		render();
		timer = setTimeout(recheck, POLL_MS);
	});
}
