/**
 * The data model: "libraries" (collections, in the old Bento sense) made of user-defined
 * fields, each holding records. One JSON file per library under dataDir()/libraries/ — plain
 * text, easy to back up or inspect by hand, plenty fast for the small personal collections
 * this app is for.
 */

import { dataDir } from "./paths.ts";

export type FieldType = "text" | "note" | "number" | "currency" | "date" | "boolean";

export interface Field {
	key: string;
	label: string;
	type: FieldType;
}

export interface Record_ {
	id: string;
	values: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

export interface Library {
	id: string;
	name: string;
	icon: string;
	fields: Field[];
	records: Record_[];
	createdAt: string;
	updatedAt: string;
}

export type LibrarySummary = Omit<Library, "records"> & { recordCount: number };

function librariesDir(): string {
	return `${dataDir()}/libraries`;
}

function libraryFile(id: string): string {
	return `${librariesDir()}/${id}.json`;
}

function isSafeId(id: string): boolean {
	return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function listLibraries(): Promise<LibrarySummary[]> {
	const dir = librariesDir();
	const summaries: LibrarySummary[] = [];
	try {
		for await (const entry of Deno.readDir(dir)) {
			if (!entry.isFile || !entry.name.endsWith(".json")) continue;
			const library = await readLibrary(entry.name.slice(0, -5));
			if (library) summaries.push(toSummary(library));
		}
	} catch (error) {
		if (!(error instanceof Deno.errors.NotFound)) throw error;
	}
	summaries.sort((a, b) => a.name.localeCompare(b.name));
	return summaries;
}

function toSummary(library: Library): LibrarySummary {
	const { records, ...rest } = library;
	return { ...rest, recordCount: records.length };
}

async function readLibrary(id: string): Promise<Library | null> {
	if (!isSafeId(id)) return null;
	try {
		return JSON.parse(await Deno.readTextFile(libraryFile(id)));
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return null;
		throw error;
	}
}

export async function getLibrary(id: string): Promise<Library | null> {
	return await readLibrary(id);
}

async function writeLibrary(library: Library): Promise<void> {
	await Deno.mkdir(librariesDir(), { recursive: true });
	await Deno.writeTextFile(libraryFile(library.id), JSON.stringify(library, null, "\t") + "\n");
}

function slugFieldKey(label: string, existing: Set<string>): string {
	const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
	let key = base, n = 2;
	while (existing.has(key)) key = `${base}_${n++}`;
	existing.add(key);
	return key;
}

export function makeFields(labels: { label: string; type: FieldType }[]): Field[] {
	const used = new Set<string>();
	return labels.map(({ label, type }) => ({ key: slugFieldKey(label, used), label, type }));
}

function newId(): string {
	return crypto.randomUUID();
}

export async function createLibrary(
	name: string,
	fields: Field[],
	icon = "layout-grid",
	records: Omit<Record_, "id">[] = [],
): Promise<Library> {
	const now = new Date().toISOString();
	const library: Library = {
		id: newId(),
		name: name.trim() || "Untitled",
		icon,
		fields,
		records: records.map((record) => ({ ...record, id: newId() })),
		createdAt: now,
		updatedAt: now,
	};
	await writeLibrary(library);
	return library;
}

export async function updateLibrarySchema(
	id: string,
	patch: { name?: string; icon?: string; fields?: Field[] },
): Promise<Library | null> {
	const library = await readLibrary(id);
	if (!library) return null;
	if (patch.name !== undefined) library.name = patch.name.trim() || library.name;
	if (patch.icon !== undefined) library.icon = patch.icon;
	if (patch.fields !== undefined) {
		const keptKeys = new Set(patch.fields.map((field) => field.key));
		library.fields = patch.fields;
		// drop values for removed fields so the JSON file doesn't accumulate orphaned data
		for (const record of library.records) {
			for (const key of Object.keys(record.values)) {
				if (!keptKeys.has(key)) delete record.values[key];
			}
		}
	}
	library.updatedAt = new Date().toISOString();
	await writeLibrary(library);
	return library;
}

export async function deleteLibrary(id: string): Promise<boolean> {
	if (!isSafeId(id)) return false;
	try {
		await Deno.remove(libraryFile(id));
		return true;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return false;
		throw error;
	}
}

export async function createRecord(libraryId: string, values: Record<string, string>): Promise<Record_ | null> {
	const library = await readLibrary(libraryId);
	if (!library) return null;
	const now = new Date().toISOString();
	const record: Record_ = { id: newId(), values, createdAt: now, updatedAt: now };
	library.records.push(record);
	library.updatedAt = now;
	await writeLibrary(library);
	return record;
}

export async function updateRecord(
	libraryId: string,
	recordId: string,
	values: Record<string, string>,
): Promise<Record_ | null> {
	const library = await readLibrary(libraryId);
	if (!library) return null;
	const record = library.records.find((r) => r.id === recordId);
	if (!record) return null;
	record.values = { ...record.values, ...values };
	record.updatedAt = new Date().toISOString();
	library.updatedAt = record.updatedAt;
	await writeLibrary(library);
	return record;
}

export async function deleteRecord(libraryId: string, recordId: string): Promise<boolean> {
	const library = await readLibrary(libraryId);
	if (!library) return false;
	const before = library.records.length;
	library.records = library.records.filter((r) => r.id !== recordId);
	if (library.records.length === before) return false;
	library.updatedAt = new Date().toISOString();
	await writeLibrary(library);
	return true;
}
