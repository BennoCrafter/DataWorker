/**
 * DataWorker itself: library sidebar, the record table, and the new-library / manage-fields /
 * import-CSV modals. Everything lives in this one module — state, rendering, and the API
 * calls — since the app is a single screen.
 */
import { $, el, lucideIcon, postJson, refreshIcons } from "./util.js";

const FIELD_TYPES = [
	{ value: "text", label: "Text" },
	{ value: "note", label: "Notiz" },
	{ value: "number", label: "Zahl" },
	{ value: "currency", label: "Betrag" },
	{ value: "date", label: "Datum" },
	{ value: "boolean", label: "Ja/Nein" },
];
const TYPE_LABEL = Object.fromEntries(FIELD_TYPES.map((t) => [t.value, t.label]));

const libState = {
	libraries: [], // summaries
	current: null, // full library {id,name,icon,fields,records,...}
	search: "",
	sortKey: null,
	sortDir: 1,
};

export function newLibraryCommand() {
	openLibraryModal();
}
export function newRecordCommand() {
	if (libState.current) addRecord(libState.current);
}
export { importCsv as importCsvCommand };

export async function initLibraryApp() {
	$("new-library-btn").onclick = () => openLibraryModal();
	$("import-csv-btn").onclick = importCsv;
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !$("modal-layer").classList.contains("hidden")) closeModal();
	});
	await loadLibraries();
}

// ── data loading ────────────────────────────────────────────────────────────

async function loadLibraries(selectId) {
	const result = await fetch("/api/libraries").then((r) => r.json()).catch(() => null);
	libState.libraries = result?.ok ? result.libraries : [];
	renderSidebar();
	if (selectId) await selectLibrary(selectId);
	else if (libState.current && !libState.libraries.some((l) => l.id === libState.current.id)) {
		libState.current = null;
		renderLibraryView();
	} else if (!libState.current && libState.libraries.length > 0) {
		await selectLibrary(libState.libraries[0].id);
	} else {
		renderLibraryView();
	}
}

async function selectLibrary(id) {
	const result = await fetch(`/api/libraries/${id}`).then((r) => r.json()).catch(() => null);
	libState.current = result?.ok ? result.library : null;
	libState.search = "";
	libState.sortKey = null;
	libState.sortDir = 1;
	renderSidebar();
	renderLibraryView();
}

// ── sidebar ─────────────────────────────────────────────────────────────────

function renderSidebar() {
	const list = $("library-list");
	list.replaceChildren();
	if (libState.libraries.length === 0) {
		list.append(el("div", "sidebar-empty text-footnote", "Noch keine Bibliothek. Mit + eine neue anlegen oder einen alten Bento-Export importieren."));
		refreshIcons(list);
		return;
	}
	for (const library of libState.libraries) {
		const item = el("button", "lib-item" + (library.id === libState.current?.id ? " active" : ""));
		item.append(lucideIcon(library.icon || "layout-grid", 16));
		item.append(el("span", "name text-subheadline", library.name));
		item.append(el("span", "count text-caption1", String(library.recordCount)));
		item.onclick = () => selectLibrary(library.id);
		list.append(item);
	}
	refreshIcons(list);
}

// ── library view: toolbar + table ────────────────────────────────────────────

function renderLibraryView() {
	const view = $("library-view");
	view.replaceChildren();
	const library = libState.current;
	if (!library) {
		const panel = el("section", "panel");
		panel.append(withStyle(el("div", "glyph", ""), { background: "var(--color-accent)" }, iconInto("layout-grid", 44)));
		const text = el("div");
		text.append(el("div", "text-title2 emphasized", "Keine Bibliothek ausgewählt"));
		text.append(el("div", "text-subheadline sub", "Links eine Bibliothek anlegen oder einen Bento-Export importieren."));
		panel.append(text);
		view.append(panel);
		return;
	}

	view.append(renderToolbar(library));
	view.append(renderTableWrap(library));
	view.append(renderFooter(library));
	refreshIcons(view);
}

function withStyle(node, style, child) {
	Object.assign(node.style, style);
	if (child) node.append(child);
	return node;
}
function iconInto(name, size) {
	return lucideIcon(name, size);
}

function renderToolbar(library) {
	const bar = el("div", "lib-toolbar");
	bar.append(el("span", "lib-title text-headline", library.name));
	bar.append(el("span", "lib-count text-caption1", `${library.records.length} Einträge`));
	bar.append(el("span", "spacer"));

	const search = el("div", "search-box");
	search.append(lucideIcon("search", 14));
	const input = document.createElement("input");
	input.type = "text";
	input.placeholder = "Suchen…";
	input.value = libState.search;
	input.oninput = () => {
		libState.search = input.value;
		const wrap = $("library-view").querySelector(".lib-table-wrap");
		if (wrap) wrap.replaceWith(renderTableWrap(library));
	};
	search.append(input);
	bar.append(search);

	const fieldsBtn = iconButton("settings-2", "Felder verwalten…", () => openLibraryModal(library));
	bar.append(fieldsBtn);
	const exportBtn = iconButton("download", "Als CSV exportieren…", () => exportLibrary(library));
	bar.append(exportBtn);
	return bar;
}

function iconButton(icon, title, onClick) {
	const btn = el("button", "icon-btn plain");
	btn.title = title;
	btn.append(lucideIcon(icon, 17));
	btn.onclick = onClick;
	return btn;
}

function visibleRecords(library) {
	let records = library.records;
	const q = libState.search.trim().toLowerCase();
	if (q) {
		records = records.filter((r) => library.fields.some((f) => (r.values[f.key] ?? "").toLowerCase().includes(q)));
	}
	if (libState.sortKey) {
		const key = libState.sortKey, dir = libState.sortDir;
		records = [...records].sort((a, b) => {
			const av = (a.values[key] ?? "").toLowerCase(), bv = (b.values[key] ?? "").toLowerCase();
			const an = Number(av.replace(",", ".")), bn = Number(bv.replace(",", "."));
			if (av !== "" && bv !== "" && !Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * dir;
			return av.localeCompare(bv) * dir;
		});
	}
	return records;
}

function renderTableWrap(library) {
	const wrap = el("div", "lib-table-wrap");
	const table = document.createElement("table");
	table.className = "lib-table";

	const thead = document.createElement("thead");
	const headRow = document.createElement("tr");
	for (const field of library.fields) {
		const th = document.createElement("th");
		th.textContent = field.label;
		th.title = TYPE_LABEL[field.type] ?? field.type;
		if (libState.sortKey === field.key) {
			th.append(el("span", "sort-arrow", libState.sortDir === 1 ? "▲" : "▼"));
		}
		th.onclick = () => {
			if (libState.sortKey === field.key) libState.sortDir *= -1;
			else {
				libState.sortKey = field.key;
				libState.sortDir = 1;
			}
			const current = $("library-view").querySelector(".lib-table-wrap");
			if (current) current.replaceWith(renderTableWrap(library));
		};
		headRow.append(th);
	}
	const actionsTh = document.createElement("th");
	actionsTh.className = "actions-col";
	headRow.append(actionsTh);
	thead.append(headRow);
	table.append(thead);

	const tbody = document.createElement("tbody");
	for (const record of visibleRecords(library)) {
		tbody.append(renderRow(library, record));
	}
	table.append(tbody);

	wrap.append(table);
	refreshIcons(wrap);
	return wrap;
}

function renderRow(library, record) {
	const tr = document.createElement("tr");
	for (const field of library.fields) {
		const td = document.createElement("td");
		td.append(renderCell(library, record, field));
		tr.append(td);
	}
	const actionsTd = document.createElement("td");
	actionsTd.className = "actions-col";
	const actions = el("div", "row-actions");
	const view = el("button", "icon-btn plain row-delete");
	view.title = "Eintrag öffnen";
	view.append(lucideIcon("maximize-2", 14));
	view.onclick = () => openRecordModal(library, record);
	actions.append(view);
	const del = el("button", "icon-btn plain row-delete");
	del.title = "Eintrag löschen";
	del.append(lucideIcon("trash-2", 15));
	del.onclick = () => confirmModal(`"${recordTitle(library, record)}" löschen?`, () => deleteRecord(library, record));
	actions.append(del);
	actionsTd.append(actions);
	tr.append(actionsTd);
	return tr;
}

function recordTitle(library, record) {
	const first = library.fields[0];
	return (first && record.values[first.key]) || "Eintrag";
}

function renderCell(library, record, field) {
	if (field.type === "boolean") {
		const td = el("div", "cell-boolean");
		const input = document.createElement("input");
		input.type = "checkbox";
		input.checked = (record.values[field.key] ?? "") !== "";
		input.onchange = () => saveField(library, record, field.key, input.checked ? "ja" : "");
		td.append(input);
		return td;
	}
	if (field.type === "note") {
		const textarea = document.createElement("textarea");
		textarea.className = "cell-input";
		textarea.rows = 2;
		textarea.value = record.values[field.key] ?? "";
		textarea.onblur = () => saveField(library, record, field.key, textarea.value);
		return textarea;
	}
	const input = document.createElement("input");
	input.type = "text";
	input.className = "cell-input" + (field.type === "number" || field.type === "currency" ? " num" : "");
	input.value = record.values[field.key] ?? "";
	input.onblur = () => saveField(library, record, field.key, input.value);
	input.onkeydown = (event) => {
		if (event.key === "Enter") input.blur();
	};
	return input;
}

async function saveField(library, record, key, value) {
	if ((record.values[key] ?? "") === value) return;
	record.values[key] = value;
	await postJson(`/api/libraries/${library.id}/records/${record.id}`, { values: { [key]: value } });
}

function renderFooter(library) {
	const footer = el("div", "lib-footer");
	const btn = el("button", "add-record-btn");
	btn.append(lucideIcon("plus", 15));
	btn.append(el("span", "text-subheadline", "Neuer Eintrag"));
	btn.onclick = () => addRecord(library);
	footer.append(btn);
	refreshIcons(footer);
	return footer;
}

async function addRecord(library) {
	const values = Object.fromEntries(library.fields.map((f) => [f.key, ""]));
	const result = await postJson(`/api/libraries/${library.id}/records`, { values });
	if (!result?.ok) return;
	library.records.push(result.record);
	const summary = libState.libraries.find((l) => l.id === library.id);
	if (summary) summary.recordCount = library.records.length;
	// clear any active search/sort so the new (empty) record is actually visible to type into
	libState.search = "";
	libState.sortKey = null;
	renderLibraryView();
	const wrap = $("library-view").querySelector(".lib-table-wrap tbody");
	const firstInput = wrap?.lastElementChild?.querySelector("input, textarea");
	firstInput?.focus();
}

async function deleteRecord(library, record) {
	const result = await postJson(`/api/libraries/${library.id}/records/${record.id}/delete`, {});
	if (!result?.ok) return;
	library.records = library.records.filter((r) => r.id !== record.id);
	const summary = libState.libraries.find((l) => l.id === library.id);
	if (summary) summary.recordCount = library.records.length;
	renderLibraryView();
}

async function exportLibrary(library) {
	const result = await postJson(`/api/libraries/${library.id}/export`, {});
	if (result?.ok) toast(`Exportiert nach ${result.path}`);
	else if (!result?.cancelled) toast(result?.error || "Export fehlgeschlagen", true);
}

async function importCsv() {
	toast("CSV-Datei wählen…");
	const result = await postJson("/api/import-csv", {});
	if (result?.ok) {
		await loadLibraries(result.library.id);
		toast(`"${result.library.name}" importiert (${result.library.records.length} Einträge)`);
	} else if (!result?.cancelled) {
		toast(result?.error || "Import fehlgeschlagen", true);
	}
}

// ── record detail view ───────────────────────────────────────────────────────

function openRecordModal(library, record) {
	const layer = $("modal-layer");
	layer.classList.remove("hidden");
	layer.replaceChildren();
	layer.onclick = (event) => {
		if (event.target === layer) closeModal();
	};

	const card = el("div", "modal-card detail-card");
	const head = el("div", "modal-head");
	head.append(el("span", "text-title3 emphasized", recordTitle(library, record)));
	const closeBtn = el("button", "icon-btn plain");
	closeBtn.append(lucideIcon("x", 16));
	closeBtn.onclick = closeModal;
	head.append(closeBtn);
	card.append(head);

	const fieldsWrap = el("div", "detail-fields");
	for (const field of library.fields) {
		const row = el("div", "detail-field");
		row.append(el("label", "text-footnote detail-label", field.label));
		row.append(renderDetailInput(library, record, field));
		fieldsWrap.append(row);
	}
	card.append(fieldsWrap);

	const meta = el(
		"div",
		"detail-meta text-caption1",
		`Erstellt ${formatDateTime(record.createdAt)} · Geändert ${formatDateTime(record.updatedAt)}`,
	);
	card.append(meta);

	const actions = el("div", "modal-actions");
	const deleteBtn = el("button", "btn-ghost modal-danger");
	deleteBtn.textContent = "Eintrag löschen";
	deleteBtn.onclick = () =>
		confirmModal(`"${recordTitle(library, record)}" löschen?`, () => deleteRecord(library, record));
	actions.append(deleteBtn);
	actions.append(el("span", "spacer"));
	const doneBtn = el("button", "btn-filled");
	doneBtn.textContent = "Fertig";
	doneBtn.onclick = closeModal;
	actions.append(doneBtn);
	card.append(actions);

	layer.append(card);
	refreshIcons(card);
	// initial auto-grow sizing needs layout, so it has to run after the card is in the document
	for (const textarea of card.querySelectorAll(".detail-textarea")) autoGrow(textarea);
}

/**
 * Old Bento's card/form view let you type more than one line into any field, not just the
 * notes — a title or a remark could wrap to a second or third line right in its box. Every
 * field here (besides the yes/no checkbox) is an auto-growing textarea for the same reason,
 * instead of a rigid single-line input.
 */
function renderDetailInput(library, record, field) {
	if (field.type === "boolean") {
		const wrap = el("label", "detail-checkbox");
		const input = document.createElement("input");
		input.type = "checkbox";
		input.checked = (record.values[field.key] ?? "") !== "";
		input.onchange = () => saveField(library, record, field.key, input.checked ? "ja" : "");
		wrap.append(input);
		wrap.append(el("span", "text-subheadline", "Ja"));
		return wrap;
	}
	const textarea = document.createElement("textarea");
	textarea.className = "detail-textarea";
	textarea.rows = 1;
	textarea.value = record.values[field.key] ?? "";
	textarea.oninput = () => autoGrow(textarea);
	textarea.onblur = () => saveField(library, record, field.key, textarea.value);
	return textarea;
}

function autoGrow(textarea) {
	textarea.style.height = "auto";
	textarea.style.height = textarea.scrollHeight + "px";
}

function formatDateTime(iso) {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

// ── new library / manage fields modal ────────────────────────────────────────

function openLibraryModal(library) {
	const layer = $("modal-layer");
	layer.classList.remove("hidden");
	layer.replaceChildren();
	layer.onclick = (event) => {
		if (event.target === layer) closeModal();
	};

	const card = el("div", "modal-card");
	const head = el("div", "modal-head");
	head.append(el("span", "text-title3 emphasized", library ? "Felder verwalten" : "Neue Bibliothek"));
	const closeBtn = el("button", "icon-btn plain");
	closeBtn.append(lucideIcon("x", 16));
	closeBtn.onclick = closeModal;
	head.append(closeBtn);
	card.append(head);

	const errorBox = el("div", "modal-error hidden");
	card.append(errorBox);

	const nameInput = document.createElement("input");
	nameInput.className = "modal-input";
	nameInput.type = "text";
	nameInput.placeholder = "Name der Bibliothek";
	nameInput.value = library?.name ?? "";
	card.append(nameInput);

	card.append(el("div", "modal-label text-footnote", "Felder"));
	const rows = el("div", "field-rows");
	card.append(rows);

	const fieldState = (library?.fields ?? []).map((f) => ({ ...f }));
	if (fieldState.length === 0) fieldState.push({ key: "", label: "", type: "text" });
	const renderRows = () => {
		rows.replaceChildren();
		fieldState.forEach((field, index) => rows.append(fieldRow(field, index, fieldState, renderRows)));
	};
	renderRows();

	const addBtn = el("button", "add-field-btn");
	addBtn.append(lucideIcon("plus", 14));
	addBtn.append(el("span", "text-footnote", "Feld hinzufügen"));
	addBtn.onclick = () => {
		fieldState.push({ key: "", label: "", type: "text" });
		renderRows();
	};
	card.append(addBtn);

	const actions = el("div", "modal-actions");
	if (library) {
		const deleteBtn = el("button", "btn-ghost modal-danger");
		deleteBtn.textContent = "Bibliothek löschen";
		deleteBtn.onclick = () =>
			confirmModal(`"${library.name}" und alle ${library.records.length} Einträge löschen?`, async () => {
				await postJson(`/api/libraries/${library.id}/delete`, {});
				closeModal();
				await loadLibraries();
			});
		actions.append(deleteBtn);
		actions.append(el("span", "spacer"));
	}
	const cancelBtn = el("button", "btn-ghost");
	cancelBtn.textContent = "Abbrechen";
	cancelBtn.onclick = closeModal;
	actions.append(cancelBtn);
	const saveBtn = el("button", "btn-filled");
	saveBtn.textContent = library ? "Speichern" : "Erstellen";
	saveBtn.onclick = async () => {
		const name = nameInput.value.trim();
		if (!name) return showError(errorBox, "Bitte einen Namen eingeben.");
		const labels = fieldState.filter((f) => f.label.trim() !== "");
		if (labels.length === 0) return showError(errorBox, "Mindestens ein Feld wird benötigt.");
		saveBtn.disabled = true;
		if (library) {
			const fields = assignKeys(labels, library.fields);
			const result = await postJson(`/api/libraries/${library.id}`, { name, fields });
			saveBtn.disabled = false;
			if (!result?.ok) return showError(errorBox, result?.error || "Speichern fehlgeschlagen.");
			closeModal();
			await loadLibraries(library.id);
		} else {
			const fields = assignKeys(labels, []);
			const result = await postJson("/api/libraries", { name, fields });
			saveBtn.disabled = false;
			if (!result?.ok) return showError(errorBox, result?.error || "Erstellen fehlgeschlagen.");
			closeModal();
			await loadLibraries(result.library.id);
		}
	};
	actions.append(saveBtn);
	card.append(actions);

	layer.append(card);
	refreshIcons(card);
	nameInput.focus();
}

function assignKeys(fields, existing) {
	const used = new Set();
	return fields.map((field) => {
		const keepsExistingKey = field.key && existing.some((e) => e.key === field.key) && !used.has(field.key);
		const key = keepsExistingKey ? field.key : slugify(field.label, used);
		used.add(key);
		return { key, label: field.label.trim(), type: field.type };
	});
}
function slugify(label, used) {
	const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
	let key = base, n = 2;
	while (used.has(key)) key = `${base}_${n++}`;
	used.add(key);
	return key;
}

function fieldRow(field, index, fieldState, rerender) {
	const row = el("div", "field-row");
	const labelInput = document.createElement("input");
	labelInput.type = "text";
	labelInput.placeholder = "Feldname";
	labelInput.value = field.label;
	labelInput.oninput = () => field.label = labelInput.value;
	row.append(labelInput);

	const select = document.createElement("select");
	for (const t of FIELD_TYPES) {
		const option = document.createElement("option");
		option.value = t.value;
		option.textContent = t.label;
		if (t.value === field.type) option.selected = true;
		select.append(option);
	}
	select.onchange = () => field.type = select.value;
	row.append(select);

	const removeBtn = el("button", "icon-btn plain");
	removeBtn.append(lucideIcon("x", 15));
	removeBtn.onclick = () => {
		fieldState.splice(index, 1);
		rerender();
	};
	row.append(removeBtn);
	refreshIcons(row);
	return row;
}

function showError(box, message) {
	box.textContent = message;
	box.classList.remove("hidden");
}

function closeModal() {
	const layer = $("modal-layer");
	layer.classList.add("hidden");
	layer.replaceChildren();
	// re-render so any field edits made in a just-closed record-detail view show up in the
	// table behind it (its cells were rendered before the modal opened, so they're stale)
	if (libState.current) renderLibraryView();
}

// ── confirm modal (used instead of window.confirm, which webview may not render) ──

function confirmModal(message, onConfirm) {
	const layer = $("modal-layer");
	layer.classList.remove("hidden");
	layer.replaceChildren();
	layer.onclick = (event) => {
		if (event.target === layer) closeModal();
	};
	const card = el("div", "modal-card");
	card.append(el("div", "text-subheadline", message));
	const actions = el("div", "modal-actions");
	const cancelBtn = el("button", "btn-ghost");
	cancelBtn.textContent = "Abbrechen";
	cancelBtn.onclick = closeModal;
	actions.append(cancelBtn);
	const confirmBtn = el("button", "btn-filled modal-danger-btn");
	confirmBtn.textContent = "Löschen";
	confirmBtn.style.background = "var(--color-red)";
	confirmBtn.onclick = async () => {
		closeModal();
		await onConfirm();
	};
	actions.append(confirmBtn);
	card.append(actions);
	layer.append(card);
}

// ── toast ───────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(message, isError = false) {
	let node = document.getElementById("app-toast");
	if (!node) {
		node = el("div", "app-toast");
		node.id = "app-toast";
		document.body.append(node);
	}
	node.textContent = message;
	node.classList.toggle("error", isError);
	node.classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => node.classList.remove("show"), 3000);
}
