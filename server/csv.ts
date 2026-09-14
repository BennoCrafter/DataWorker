/**
 * CSV import/export — reads the semicolon-delimited exports the old Bento produced (and
 * writes the same shape back out), with a conservative per-column type guess so an imported
 * library gets sensible input controls without ever mangling a value it isn't sure about.
 *
 * Field values are always kept as plain strings, exactly as typed or imported — `type` only
 * picks the input control and display formatting in the UI, it is never used to coerce or
 * reformat stored data. That keeps import/export lossless and the storage format trivial.
 */

import type { Field, FieldType } from "./library.ts";
import { makeFields } from "./library.ts";

const DELIMITER = ";";

/** RFC4180-ish parse: quoted fields, doubled-quote escaping, CRLF or LF, optional trailing newline. */
export function parseCsv(text: string): string[][] {
	const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const rows: string[][] = [];
	let row: string[] = [], field = "", inQuotes = false, i = 0;
	while (i < clean.length) {
		const char = clean[i];
		if (inQuotes) {
			if (char === '"') {
				if (clean[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += char;
			i++;
			continue;
		}
		if (char === '"') {
			inQuotes = true;
			i++;
			continue;
		}
		if (char === DELIMITER) {
			row.push(field);
			field = "";
			i++;
			continue;
		}
		if (char === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
			continue;
		}
		field += char;
		i++;
	}
	row.push(field);
	if (row.length > 1 || row[0] !== "") rows.push(row);
	return rows;
}

function csvField(value: string): string {
	return /[";\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : `"${value}"`;
}

export function toCsv(headers: string[], rows: string[][]): string {
	const lines = [headers, ...rows].map((cells) => cells.map(csvField).join(DELIMITER));
	return lines.join("\r\n") + "\r\n";
}

// dd.MM.yyyy or dd.MM.yy, optionally followed by HH:mm
const DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?$/;
const CURRENCY_RE = /^-?\d+(?:\.\d{3})*,\d{2}\s?€$/;
const NUMBER_RE = /^-?\d+(?:[.,]\d+)?$/;
const BOOLEAN_TOKENS = new Set(["ja", "nein", "yes", "no", "x", "true", "false", "wahr", "falsch"]);
const META_CREATED = new Set(["erstellungsdatum", "created", "createdat"]);
const META_UPDATED = new Set(["änderungsdatum", "aenderungsdatum", "updated", "updatedat"]);

/** Parses "dd.MM.yyyy[ HH:mm]" into an ISO string, or null if it doesn't match / isn't a real date. */
export function parseGermanDateTime(value: string): string | null {
	const match = DATE_RE.exec(value.trim());
	if (!match) return null;
	const [, d, m, y, hh, mm] = match;
	const year = y.length === 2 ? 2000 + Number(y) : Number(y);
	const date = new Date(year, Number(m) - 1, Number(d), Number(hh ?? "0"), Number(mm ?? "0"));
	if (date.getFullYear() !== year || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return null;
	return date.toISOString();
}

/** Formats an ISO timestamp back as "dd.MM.yyyy HH:mm" for CSV export. */
export function toGermanDateTime(iso: string): string {
	const date = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${
		pad(date.getMinutes())
	}`;
}

function guessType(values: string[]): FieldType {
	const nonEmpty = values.map((v) => v.trim()).filter((v) => v !== "");
	if (nonEmpty.length === 0) return "text";
	if (nonEmpty.every((v) => CURRENCY_RE.test(v))) return "currency";
	if (nonEmpty.every((v) => DATE_RE.test(v))) return "date";
	if (nonEmpty.every((v) => NUMBER_RE.test(v))) return "number";
	if (nonEmpty.every((v) => BOOLEAN_TOKENS.has(v.toLowerCase()))) return "boolean";
	if (nonEmpty.some((v) => v.length > 80 || v.includes("\n"))) return "note";
	return "text";
}

export interface ImportedLibrary {
	fields: Field[];
	records: { values: Record<string, string>; createdAt: string; updatedAt: string }[];
}

/** Turns a Bento-style CSV export into a library's fields + records. */
export function importCsv(text: string): ImportedLibrary {
	const rows = parseCsv(text);
	if (rows.length === 0) return { fields: [], records: [] };
	const [header, ...dataRows] = rows;

	const createdIndex = header.findIndex((h) => META_CREATED.has(h.trim().toLowerCase()));
	const updatedIndex = header.findIndex((h) => META_UPDATED.has(h.trim().toLowerCase()));
	const fieldIndexes = header.map((_, i) => i).filter((i) => i !== createdIndex && i !== updatedIndex);

	const columnValues = fieldIndexes.map((i) => dataRows.map((row) => row[i] ?? ""));
	const fields = makeFields(fieldIndexes.map((i, j) => ({ label: header[i].trim() || `Field ${i + 1}`, type: guessType(columnValues[j]) })));

	const now = new Date().toISOString();
	const records = dataRows
		.filter((row) => row.some((cell) => cell.trim() !== ""))
		.map((row) => {
			const values: Record<string, string> = {};
			fieldIndexes.forEach((i, j) => {
				values[fields[j].key] = (row[i] ?? "").trim();
			});
			const createdAt = createdIndex >= 0 ? parseGermanDateTime(row[createdIndex] ?? "") ?? now : now;
			const updatedAt = updatedIndex >= 0 ? parseGermanDateTime(row[updatedIndex] ?? "") ?? createdAt : createdAt;
			return { values, createdAt, updatedAt };
		});

	return { fields, records };
}

export function exportCsv(fields: Field[], records: { values: Record<string, string>; createdAt: string; updatedAt: string }[]): string {
	const headers = ["Erstellungsdatum", "Änderungsdatum", ...fields.map((f) => f.label)];
	const rows = records.map((record) => [
		toGermanDateTime(record.createdAt),
		toGermanDateTime(record.updatedAt),
		...fields.map((f) => record.values[f.key] ?? ""),
	]);
	return toCsv(headers, rows);
}
