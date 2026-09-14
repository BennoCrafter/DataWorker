/**
 * OPTIONAL FEATURE (features.prerequisites): the startup gate. Before the UI lets the user in,
 * every prerequisite registered here is checked (GET /api/prereqs); ui/js/prereqs.js shows a
 * blocking screen listing whatever is missing and re-checks (a button, plus a gentle auto-poll)
 * until everything passes. REGISTER YOUR APP'S PREREQUISITES in the PREREQUISITES list;
 * binaryPrerequisite() covers the common "is tool X installed" case and portPrerequisite() the
 * "is port N still free" one, anything else is a custom check().
 *
 * Each item can guide the user in up to three ways: prose (`hint`), shell `commands` rendered
 * as copyable code blocks, and a `link` opened in the real browser (registered in
 * externalLinks, since a webview must not navigate away from the app). An item the app can fix
 * itself also carries a `fix` — an input field in the gate whose value is POSTed back to
 * /api/prereqs/fix and handed to the item's `apply()`, so e.g. a pasted token or a keychain
 * password is installed without the user touching a terminal or reaching Settings.
 *
 * Escape hatch: <PREFIX>_SKIP_PREREQS=1 reports the gate as satisfied without checking — for
 * development, CI, and users whose environment confuses a check. The inverse testing aid,
 * <PREFIX>_FAIL_PREREQS=1, forces every item to fail so the gate (hints, commands, fix forms)
 * can be reviewed on a machine where everything is installed.
 */

import { appEnv } from "../app.config.ts";
import { json } from "./http.ts";
import { externalLinks } from "./system.ts";

/** An input field the gate offers for an item the app can fix itself. */
export interface PrereqFix {
	/** Masked unless "text" — every value the gate collects here is a secret by default. */
	type: "password" | "text";
	placeholder: string;
	submitLabel?: string;
	/** One extra line under the field — e.g. where the value ends up. */
	note?: string;
}

export interface Prerequisite {
	id: string;
	/** Human name shown in the gate, e.g. "Git". */
	label: string;
	/** Guidance shown when the check fails — prose only; commands go in `commands`. */
	hint: string;
	/** Shell commands for the user to run, each a copyable code block in the gate. */
	commands?: string[];
	/** A page that helps (token creation, …) — opened in the browser, not the webview. */
	link?: { url: string; label: string };
	/**
	 * Decides pass/fail. `detail` is shown next to the label when the item passes and as the
	 * "what is wrong" line when it fails; `commands` replaces the static ones (a diagnosis the
	 * check worked out, e.g. which port to inspect).
	 */
	check(): Promise<{ ok: boolean; detail?: string; fix?: PrereqFix; commands?: string[] }>;
	/** Installs a value pasted into the gate's fix field; throws with a user-facing message. */
	apply?(value: string): Promise<void>;
}

/** REGISTER your app's prerequisites here — all are checked and shown together. */
const PREREQUISITES: Prerequisite[] = [
	binaryPrerequisite("git", "Git", "Install Apple's command-line tools — or git via Homebrew:", [
		"xcode-select --install",
		"brew install git",
	]),
	// ── your app's prerequisites here ──
];

// where a Finder/Dock-launched app (which has a bare PATH) still finds Homebrew and friends
const CANDIDATE_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/** A prerequisite that passes when `bin` is installed (candidate dirs first, then PATH). */
export function binaryPrerequisite(bin: string, label: string, hint: string, commands: string[] = []): Prerequisite {
	return {
		id: bin,
		label,
		hint,
		commands,
		check: async () => {
			for (const dir of CANDIDATE_DIRS) {
				try {
					const stat = await Deno.stat(`${dir}/${bin}`);
					if (stat.isFile || stat.isSymlink) return { ok: true, detail: `${dir}/${bin}` };
				} catch {
					// not here — try the next candidate
				}
			}
			// a dev launch has a real PATH — accept the bare name if it answers
			try {
				const probe = await new Deno.Command(bin, {
					args: ["--version"],
					stdin: "null",
					stdout: "null",
					stderr: "null",
				}).output();
				if (probe.success) return { ok: true, detail: bin };
			} catch {
				// not on PATH either
			}
			return { ok: false };
		},
	};
}

/**
 * A prerequisite that passes while nothing is listening on `port` — for apps that must bind a
 * fixed port. A momentary bind is the probe, and BOTH addresses have to be tried: binds are
 * address-specific, so a 127.0.0.1-only listener does not block a 0.0.0.0 bind and a 0.0.0.0
 * listener does not block a 127.0.0.1 bind (verified on macOS).
 */
export function portPrerequisite(port: number, label: string, hint: string): Prerequisite {
	return {
		id: `port-${port}`,
		label,
		hint,
		commands: [`lsof -nP -iTCP:${port} -sTCP:LISTEN`],
		check: () => {
			for (const hostname of ["0.0.0.0", "127.0.0.1"]) {
				try {
					Deno.listen({ hostname, port }).close();
				} catch {
					return Promise.resolve({ ok: false, detail: `Port ${port} is already in use.` });
				}
			}
			return Promise.resolve({ ok: true, detail: `${port} free` });
		},
	};
}

// the gate's links are opened through /api/open-url, which only accepts registered URLs
for (const prereq of PREREQUISITES) {
	if (prereq.link) externalLinks.add(prereq.link.url);
}

/** The /api/prereqs snapshot: every registered check, and whether the gate may open. */
export async function checkPrerequisites(): Promise<Record<string, unknown>> {
	if (appEnv("SKIP_PREREQS") === "1") return { ok: true, satisfied: true, skipped: true, items: [] };
	// testing aid: force every item to fail so the gate's guidance can be reviewed
	const failAll = appEnv("FAIL_PREREQS") === "1";
	const items = await Promise.all(PREREQUISITES.map(async (prereq) => {
		const shared = {
			id: prereq.id,
			label: prereq.label,
			hint: prereq.hint,
			commands: prereq.commands ?? [],
			link: prereq.link ?? null,
		};
		try {
			const result = await prereq.check();
			return {
				...shared,
				// a check may have worked out better commands than the static ones
				commands: result.commands ?? shared.commands,
				ok: result.ok && !failAll,
				detail: failAll ? null : result.detail ?? null,
				fix: result.fix ?? null,
			};
		} catch (error) {
			// a crashing check counts as failed, with the error as its detail
			return { ...shared, ok: false, detail: error instanceof Error ? error.message : String(error), fix: null };
		}
	}));
	return { ok: true, satisfied: items.every((item) => item.ok), skipped: false, items };
}

/** POST /api/prereqs/fix — installs {value} for the prerequisite {id} via its apply(). */
export async function handlePrereqFix(request: Request): Promise<Response> {
	const body = await request.json().catch(() => ({}));
	const prereq = PREREQUISITES.find((item) => item.id === body?.id);
	if (!prereq?.apply) return json({ ok: false, error: "unknown prerequisite" }, 400);
	const value = String(body?.value ?? "").trim();
	if (!value) return json({ ok: false, error: "nothing to save" }, 400);
	try {
		await prereq.apply(value);
		return json({ ok: true });
	} catch (error) {
		return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
	}
}
