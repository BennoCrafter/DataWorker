/**
 * HTTP plumbing: JSON responses, the NDJSON progress-stream convention shared with the client's
 * postStream(), and the static file server for ui/.
 */

import { ROOT, sanitizeRelativePath } from "./paths.ts";

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** pct is 0..1 (or null for indeterminate); message is the current step label. */
export type Progress = (pct: number | null, message: string) => void;

/**
 * Streams NDJSON progress: each `{pct,message}` line during the run, then a final
 * `{done:true, ...result}` line. Consumed by the client's postStream().
 */
export function streamResponse(run: (emit: Progress) => Promise<Record<string, unknown>>): Response {
	const body = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
			try {
				const result = await run((pct, message) => send({ pct, message }));
				send({ done: true, ...result });
			} catch (error) {
				send({ done: true, ok: false, error: error instanceof Error ? error.message : String(error) });
			} finally {
				controller.close();
			}
		},
	});
	return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

const STATIC_TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	json: "application/json",
	svg: "image/svg+xml",
	png: "image/png",
	ico: "image/x-icon",
	woff2: "font/woff2",
};

export async function serveStatic(pathname: string): Promise<Response> {
	const relative = pathname === "/" ? ["index.html"] : sanitizeRelativePath(pathname);
	const path = [`${ROOT}ui`, ...relative].join("/");
	const extension = path.split(".").pop() ?? "";
	try {
		const file = await Deno.open(path, { read: true });
		return new Response(file.readable, {
			headers: { "content-type": STATIC_TYPES[extension] ?? "application/octet-stream" },
		});
	} catch {
		return new Response("not found", { status: 404 });
	}
}
