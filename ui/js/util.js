/**
 * Shared helpers: DOM shortcuts ($, el, lucide icons), formatting, and the fetch wrappers —
 * postJson for JSON endpoints, postStream for NDJSON progress streams (the client side of the
 * server's streamResponse()).
 */

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function lucideIcon(name, size, color) {
	const node = el("i");
	node.dataset.lucide = name;
	node.setAttribute("width", size);
	node.setAttribute("height", size);
	if (color) node.style.color = color;
	node.style.flex = "none";
	node.style.display = "flex";
	return node;
}

export function refreshIcons(root) {
	try {
		// scope the scan to `root` when given — converting only its placeholders keeps
		// per-frame repaints cheap; a bare call rescans the whole document
		if (window.lucide?.createIcons) window.lucide.createIcons(root ? { root } : undefined);
	} catch { /* icons stay as placeholders */ }
}

export async function postForm(path, form) {
	try {
		return await (await fetch(path, { method: "POST", body: form })).json();
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

export async function postJson(path, body) {
	try {
		return await (await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		})).json();
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

// posts JSON and consumes an NDJSON progress stream: onProgress({pct,message}) per line,
// resolving to the final {done:true,...result} event
export async function postStream(path, body, onProgress) {
	let response;
	try {
		response = await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		return { ok: false, error: String(error) };
	}
	if (!response.body) return await response.json().catch(() => ({ ok: false, error: "no response" }));
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "", result = null;
	const consume = (line) => {
		if (!line.trim()) return;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.done) result = event;
		else onProgress?.(event);
	};
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) consume(line);
	}
	consume(buffer);
	return result ?? { ok: false, error: "no result from server" };
}

export function dirName(path) {
	return path.slice(0, path.lastIndexOf("/")) || path;
}
