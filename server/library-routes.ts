/**
 * Routes for the library/record CRUD and CSV import/export — kept out of server.ts to keep
 * that file a thin route table, per its own convention.
 *
 * handleLibraryApi covers everything under /api/libraries*; returns null for any other path
 * so server.ts can fall through to its remaining routes. handleImportCsv is separate since it
 * creates a *new* library rather than acting on an existing :id.
 */

import { json } from "./http.ts";
import {
	createLibrary,
	createRecord,
	deleteLibrary,
	deleteRecord,
	getLibrary,
	listLibraries,
	updateLibrarySchema,
	updateRecord,
} from "./library.ts";
import type { Field } from "./library.ts";
import { exportCsv, importCsv } from "./csv.ts";
import { pickNative, pickSaveFile, producedOutputs } from "./system.ts";

function normalizeValues(input: unknown): Record<string, string> {
	if (!input || typeof input !== "object") return {};
	return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]));
}

function isFieldArray(value: unknown): value is Field[] {
	return Array.isArray(value) &&
		value.every((f) =>
			f && typeof f === "object" && typeof f.key === "string" && typeof f.label === "string" &&
			typeof f.type === "string"
		);
}

export async function handleLibraryApi(request: Request, url: URL): Promise<Response | null> {
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments[0] !== "api" || segments[1] !== "libraries") return null;
	const method = request.method;
	const id = segments[2];

	if (segments.length === 2) {
		if (method === "GET") return json({ ok: true, libraries: await listLibraries() });
		if (method === "POST") {
			const body = await request.json().catch(() => ({}));
			const name = typeof body.name === "string" ? body.name : "";
			const fields = isFieldArray(body.fields) ? body.fields : [];
			const library = await createLibrary(name, fields, typeof body.icon === "string" ? body.icon : undefined);
			return json({ ok: true, library });
		}
		return json({ ok: false, error: "method not allowed" }, 405);
	}

	if (segments.length === 3) {
		if (method === "GET") {
			const library = await getLibrary(id);
			return library ? json({ ok: true, library }) : json({ ok: false, error: "not found" }, 404);
		}
		if (method === "POST") {
			const body = await request.json().catch(() => ({}));
			const patch: { name?: string; icon?: string; fields?: Field[] } = {};
			if (typeof body.name === "string") patch.name = body.name;
			if (typeof body.icon === "string") patch.icon = body.icon;
			if (isFieldArray(body.fields)) patch.fields = body.fields;
			const library = await updateLibrarySchema(id, patch);
			return library ? json({ ok: true, library }) : json({ ok: false, error: "not found" }, 404);
		}
		return json({ ok: false, error: "method not allowed" }, 405);
	}

	if (segments.length === 4 && segments[3] === "delete" && method === "POST") {
		const ok = await deleteLibrary(id);
		return json({ ok });
	}

	if (segments.length === 4 && segments[3] === "export" && method === "POST") {
		const library = await getLibrary(id);
		if (!library) return json({ ok: false, error: "not found" }, 404);
		// the name is interpolated straight into an AppleScript/zenity command by pickSaveFile,
		// so strip characters that could break out of that quoting
		const safeName = library.name.replaceAll(/["'\\]/g, "").trim() || "Bibliothek";
		const path = await pickSaveFile("Bibliothek exportieren", `${safeName}.csv`);
		if (!path) return json({ ok: false, cancelled: true });
		const csv = exportCsv(library.fields, library.records);
		await Deno.writeTextFile(path, csv);
		producedOutputs.add(path);
		return json({ ok: true, path });
	}

	if (segments.length === 4 && segments[3] === "records" && method === "POST") {
		const body = await request.json().catch(() => ({}));
		const values = normalizeValues(body?.values);
		const record = await createRecord(id, values);
		return record ? json({ ok: true, record }) : json({ ok: false, error: "not found" }, 404);
	}

	if (segments.length === 5 && segments[3] === "records" && method === "POST") {
		const recordId = segments[4];
		const body = await request.json().catch(() => ({}));
		const values = normalizeValues(body?.values);
		const record = await updateRecord(id, recordId, values);
		return record ? json({ ok: true, record }) : json({ ok: false, error: "not found" }, 404);
	}

	if (segments.length === 6 && segments[3] === "records" && segments[5] === "delete" && method === "POST") {
		const recordId = segments[4];
		const ok = await deleteRecord(id, recordId);
		return json({ ok });
	}

	return json({ ok: false, error: "not found" }, 404);
}

/** Picks a CSV file and imports it as a brand-new library named after the file. */
export async function handleImportCsv(): Promise<Response> {
	const path = await pickNative("Bento-Export importieren", false, ["csv"]);
	if (!path) return json({ ok: false, cancelled: true });
	let text: string;
	try {
		text = await Deno.readTextFile(path);
	} catch (error) {
		return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
	}
	const name = (path.split("/").pop() ?? "Import").replace(/\.csv$/i, "");
	const { fields, records } = importCsv(text);
	const library = await createLibrary(name, fields, "layout-grid", records);
	return json({ ok: true, library });
}
