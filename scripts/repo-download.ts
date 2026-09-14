/**
 * Console adapter around server/repo.ts for the build scripts: authenticated downloads with a
 * progress line — updated in place on a TTY, one line per 10% (or 50 MB when the size is
 * unknown) otherwise.
 */

import { downloadFile as repoDownloadFile, type DownloadInfo, fetchText } from "../server/repo.ts";

export { type DownloadInfo, fetchText };

export async function downloadFile(url: string, target: string, label?: string): Promise<DownloadInfo> {
	const progress = new ConsoleProgress(label ?? target.split("/").pop() ?? "download");
	const info = await repoDownloadFile(url, target, (received, total) => progress.update(received, total));
	progress.finish();
	return info;
}

class ConsoleProgress {
	private received = 0;
	private total: number | null = null;
	private lastRender = 0;
	private lastStep = 0;
	private lastPrinted = -1;
	private readonly tty = Deno.stdout.isTerminal();
	private readonly encoder = new TextEncoder();

	constructor(private readonly label: string) {}

	update(received: number, total: number | null): void {
		this.received = received;
		this.total = total;
		if (this.tty) {
			const now = Date.now();
			if (now - this.lastRender < 100) return;
			this.lastRender = now;
			this.print(`\r${this.line()}   `);
		} else {
			const step = total ? Math.floor((received / total) * 10) : Math.floor(received / (50 * 1024 * 1024));
			if (step <= this.lastStep) return;
			this.lastStep = step;
			this.lastPrinted = received;
			this.print(`${this.line()}\n`);
		}
	}

	finish(): void {
		if (this.tty) this.print(`\r${this.line()}   \n`);
		else if (this.received !== this.lastPrinted) this.print(`${this.line()}\n`);
	}

	private line(): string {
		const done = megabytes(this.received);
		if (!this.total) return `${this.label}  ${done}`;
		const percent = Math.min(100, Math.floor((this.received / this.total) * 100));
		return `${this.label}  ${done} / ${megabytes(this.total)}  (${percent}%)`;
	}

	private print(text: string): void {
		Deno.stdout.writeSync(this.encoder.encode(text));
	}
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
