import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

// Several converters can run at once (one per build lane, docs/architecture.md): each process has its own port,
// temp dir and LibreOffice profile, so they never lock or clean up each other's files.

export const PORT = Number(process.env.CONVERTER_PORT ?? 4322);
export const HOST = "127.0.0.1";
export const SECRET = process.env.CONVERTER_SECRET ?? "";
export const SOFFICE = process.env.SOFFICE_PATH ?? "/opt/homebrew/bin/soffice";
export const PDFTOPPM = process.env.PDFTOPPM_PATH ?? "/opt/homebrew/bin/pdftoppm";
export const PDFTOTEXT = process.env.PDFTOTEXT_PATH ?? "/opt/homebrew/bin/pdftotext";
export const PDFINFO = process.env.PDFINFO_PATH ?? "/opt/homebrew/bin/pdfinfo";
export const KEYNOTE_APP = "/Applications/Keynote.app";
/** Optional: re-encodes video/audio that PowerPoint and Keynote can't play (webm, ogg...) into mp4/mp3. */
export const FFMPEG = process.env.FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg";
/** Max request body (base64 imports of big decks). */
export const MAX_BODY = Number(process.env.CONVERTER_MAX_BODY ?? 1024 * 1024 * 1024);

export const WORK_DIR = join(process.env.CONVERTER_TMP ?? tmpdir(), `silicon-present-converter-${process.pid}`);
mkdirSync(WORK_DIR, { recursive: true });

let jobN = 0;
/** A fresh temp dir for one job; call the returned cleanup when done. */
export function jobDir(): { dir: string; cleanup: () => void } {
  const dir = join(WORK_DIR, `job-${Date.now()}-${++jobN}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function cleanupWorkDir(): void {
  rmSync(WORK_DIR, { recursive: true, force: true });
}

export const HAVE = {
  soffice: () => existsSync(SOFFICE),
  pdftoppm: () => existsSync(PDFTOPPM),
  keynote: () => process.platform === "darwin" && existsSync(KEYNOTE_APP),
  ffmpeg: () => existsSync(FFMPEG),
};
