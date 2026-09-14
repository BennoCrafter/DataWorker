/**
 * DataWorker itself: library sidebar, the record table, and the new-library / manage-fields /
 * import-CSV modals. Everything lives in this one module — state, rendering, and the API
 * calls — since the app is a single screen.
 */
import { $, el, lucideIcon, postJson, refreshIcons } from "./util.js";
import { currentLanguage, onLanguageChange, t } from "./i18n.js";
import { config, saveConfig } from "./config.js";

/** A stable accent color per library, derived from its id — a small nod to Bento's colorful icons. */
function libraryColor(id) {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
	return `hsl(${Math.abs(hash) % 360}, 65%, 52%)`;
}

function fieldTypes() {
	return [
		{ value: "text", label: t("fieldType.text") },
		{ value: "note", label: t("fieldType.note") },
		{ value: "number", label: t("fieldType.number") },
		{ value: "currency", label: t("fieldType.currency") },
		{ value: "date", label: t("fieldType.date") },
		{ value: "boolean", label: t("fieldType.boolean") },
	];
}

const libState = {
	libraries: [], // summaries
	current: null, // full library {id,name,icon,fields,records,...}
	search: "",
	sortKey: null,
	sortDir: 1,
};

/** Per-library search/sort, remembered across library switches and app restarts. */
function loadLibraryView(id) {
	const saved = config.libraryViews?.[id];
	return { search: saved?.search ?? "", sortKey: saved?.sortKey ?? null, sortDir: saved?.sortDir ?? 1 };
}

let viewSaveTimer = null;
function persistLibraryView(id) {
	config.libraryViews ??= {};
	config.libraryViews[id] = { search: libState.search, sortKey: libState.sortKey, sortDir: libState.sortDir };
	clearTimeout(viewSaveTimer);
	viewSaveTimer = setTimeout(saveConfig, 400);
}

function forgetLibraryView(id) {
	if (config.libraryViews) delete config.libraryViews[id];
	saveConfig();
}

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
	onLanguageChange(() => {
		renderSidebar();
		renderLibraryView();
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
	const view = loadLibraryView(id);
	libState.search = view.search;
	libState.sortKey = view.sortKey;
	libState.sortDir = view.sortDir;
	renderSidebar();
	renderLibraryView();
}

// ── sidebar ─────────────────────────────────────────────────────────────────

function renderSidebar() {
	const list = $("library-list");
	list.replaceChildren();
	if (libState.libraries.length === 0) {
		list.append(el("div", "sidebar-empty text-footnote", t("sidebar.empty")));
		refreshIcons(list);
		return;
	}
	for (const library of libState.libraries) {
		const item = el("button", "lib-item" + (library.id === libState.current?.id ? " active" : ""));
		const tile = el("span", "lib-icon-tile");
		tile.style.background = libraryColor(library.id);
		tile.append(lucideIcon(library.icon || "layout-grid", 13, "#fff"));
		item.append(tile);
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
		text.append(el("div", "text-title2 emphasized", t("library.noneSelectedTitle")));
		text.append(el("div", "text-subheadline sub", t("library.noneSelectedSub")));
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
	const dot = el("span", "lib-color-dot");
	dot.style.background = libraryColor(library.id);
	bar.append(dot);
	bar.append(el("span", "lib-title text-headline", library.name));
	bar.append(el("span", "lib-count text-caption1", t("library.entriesCount", { count: library.records.length })));
	bar.append(el("span", "spacer"));

	const search = el("div", "search-box");
	search.append(lucideIcon("search", 14));
	const input = document.createElement("input");
	input.type = "text";
	input.placeholder = t("library.searchPlaceholder");
	input.value = libState.search;
	input.oninput = () => {
		libState.search = input.value;
		persistLibraryView(library.id);
		const wrap = $("library-view").querySelector(".lib-table-wrap");
		if (wrap) wrap.replaceWith(renderTableWrap(library));
	};
	search.append(input);
	bar.append(search);

	const fieldsBtn = iconButton("settings-2", t("library.manageFieldsTitle"), () => openLibraryModal(library));
	bar.append(fieldsBtn);
	const exportBtn = iconButton("download", t("library.exportCsvTitle"), () => exportLibrary(library));
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

	const typeLabel = Object.fromEntries(fieldTypes().map((ft) => [ft.value, ft.label]));
	const thead = document.createElement("thead");
	const headRow = document.createElement("tr");
	for (const field of library.fields) {
		const th = document.createElement("th");
		th.textContent = field.label;
		th.title = typeLabel[field.type] ?? field.type;
		if (libState.sortKey === field.key) {
			th.append(el("span", "sort-arrow", libState.sortDir === 1 ? "▲" : "▼"));
		}
		th.onclick = () => {
			if (libState.sortKey === field.key) libState.sortDir *= -1;
			else {
				libState.sortKey = field.key;
				libState.sortDir = 1;
			}
			persistLibraryView(library.id);
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
	view.title = t("record.openTitle");
	view.append(lucideIcon("maximize-2", 14));
	view.onclick = () => openRecordModal(library, record);
	actions.append(view);
	const del = el("button", "icon-btn plain row-delete");
	del.title = t("record.deleteTitle");
	del.append(lucideIcon("trash-2", 15));
	del.onclick = () =>
		confirmModal(t("record.confirmDelete", { title: recordTitle(library, record) }), () => deleteRecord(library, record));
	actions.append(del);
	actionsTd.append(actions);
	tr.append(actionsTd);
	return tr;
}

function recordTitle(library, record) {
	const first = library.fields[0];
	return (first && record.values[first.key]) || t("record.fallbackTitle");
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
	btn.append(el("span", "text-subheadline", t("library.newRecord")));
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
	persistLibraryView(library.id);
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
	if (result?.ok) toast(t("toast.exportedTo", { path: result.path }));
	else if (!result?.cancelled) toast(result?.error || t("toast.exportFailed"), true);
}

async function importCsv() {
	toast(t("toast.chooseCsv"));
	const result = await postJson("/api/import-csv", {});
	if (result?.ok) {
		await loadLibraries(result.library.id);
		toast(t("toast.imported", { name: result.library.name, count: result.library.records.length }));
	} else if (!result?.cancelled) {
		toast(result?.error || t("toast.importFailed"), true);
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
		t("record.meta", { created: formatDateTime(record.createdAt), updated: formatDateTime(record.updatedAt) }),
	);
	card.append(meta);

	const actions = el("div", "modal-actions");
	const deleteBtn = el("button", "btn-ghost modal-danger");
	deleteBtn.textContent = t("record.deleteButton");
	deleteBtn.onclick = () =>
		confirmModal(t("record.confirmDelete", { title: recordTitle(library, record) }), () => deleteRecord(library, record));
	actions.append(deleteBtn);
	actions.append(el("span", "spacer"));
	const doneBtn = el("button", "btn-filled");
	doneBtn.textContent = t("common.done");
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
		wrap.append(el("span", "text-subheadline", t("common.yes")));
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
		return new Date(iso).toLocaleString(currentLanguage() === "de" ? "de-DE" : "en-US");
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
	head.append(el("span", "text-title3 emphasized", library ? t("modal.manageFields") : t("modal.newLibrary")));
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
	nameInput.placeholder = t("modal.libraryNamePlaceholder");
	nameInput.value = library?.name ?? "";
	card.append(nameInput);

	card.append(el("div", "modal-label text-footnote", t("modal.fieldsLabel")));
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
	addBtn.append(el("span", "text-footnote", t("modal.addField")));
	addBtn.onclick = () => {
		fieldState.push({ key: "", label: "", type: "text" });
		renderRows();
	};
	card.append(addBtn);

	const actions = el("div", "modal-actions");
	if (library) {
		const deleteBtn = el("button", "btn-ghost modal-danger");
		deleteBtn.textContent = t("modal.deleteLibrary");
		deleteBtn.onclick = () =>
			confirmModal(t("modal.confirmDeleteLibrary", { name: library.name, count: library.records.length }), async () => {
				await postJson(`/api/libraries/${library.id}/delete`, {});
				forgetLibraryView(library.id);
				closeModal();
				await loadLibraries();
			});
		actions.append(deleteBtn);
		actions.append(el("span", "spacer"));
	}
	const cancelBtn = el("button", "btn-ghost");
	cancelBtn.textContent = t("common.cancel");
	cancelBtn.onclick = closeModal;
	actions.append(cancelBtn);
	const saveBtn = el("button", "btn-filled");
	saveBtn.textContent = library ? t("common.save") : t("common.create");
	saveBtn.onclick = async () => {
		const name = nameInput.value.trim();
		if (!name) return showError(errorBox, t("error.nameRequired"));
		const labels = fieldState.filter((f) => f.label.trim() !== "");
		if (labels.length === 0) return showError(errorBox, t("error.fieldRequired"));
		saveBtn.disabled = true;
		if (library) {
			const fields = assignKeys(labels, library.fields);
			const result = await postJson(`/api/libraries/${library.id}`, { name, fields });
			saveBtn.disabled = false;
			if (!result?.ok) return showError(errorBox, result?.error || t("error.saveFailed"));
			closeModal();
			await loadLibraries(library.id);
		} else {
			const fields = assignKeys(labels, []);
			const result = await postJson("/api/libraries", { name, fields });
			saveBtn.disabled = false;
			if (!result?.ok) return showError(errorBox, result?.error || t("error.createFailed"));
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

	// drag-to-reorder: only the grip is draggable, so the text/select inputs stay normal
	const grip = el("span", "field-grip");
	grip.append(lucideIcon("grip-vertical", 14));
	grip.draggable = true;
	grip.ondragstart = (event) => {
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", String(index));
		row.classList.add("dragging");
	};
	grip.ondragend = () => row.classList.remove("dragging");
	row.append(grip);

	let dragDepth = 0;
	row.ondragover = (event) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
	};
	row.ondragenter = () => {
		dragDepth++;
		row.classList.add("drag-over");
	};
	row.ondragleave = () => {
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) row.classList.remove("drag-over");
	};
	row.ondrop = (event) => {
		event.preventDefault();
		dragDepth = 0;
		row.classList.remove("drag-over");
		const from = Number(event.dataTransfer.getData("text/plain"));
		if (Number.isNaN(from) || from === index) return;
		const [moved] = fieldState.splice(from, 1);
		fieldState.splice(index, 0, moved);
		rerender();
	};

	const labelInput = document.createElement("input");
	labelInput.type = "text";
	labelInput.placeholder = t("modal.fieldNamePlaceholder");
	labelInput.value = field.label;
	labelInput.oninput = () => field.label = labelInput.value;
	row.append(labelInput);

	const select = document.createElement("select");
	for (const fieldType of fieldTypes()) {
		const option = document.createElement("option");
		option.value = fieldType.value;
		option.textContent = fieldType.label;
		if (fieldType.value === field.type) option.selected = true;
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
	cancelBtn.textContent = t("common.cancel");
	cancelBtn.onclick = closeModal;
	actions.append(cancelBtn);
	const confirmBtn = el("button", "btn-filled modal-danger-btn");
	confirmBtn.textContent = t("common.delete");
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
