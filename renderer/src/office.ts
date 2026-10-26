import { copyFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { HAVE, KEYNOTE_APP, SOFFICE, WORK_DIR } from "./config";
import { ConverterError } from "./errors";
import { run, serial } from "./proc";
import { withKeynoteLock } from "./keynote-lock";

// LibreOffice (headless, one private profile per converter process, one conversion at a time) and Keynote
// (AppleScript, one at a time across converter processes on this Mac).

const sofficeQueue = serial();
const keynoteQueue = serial();
// Deliberately outside CONVERTER_TMP, which is different in each build lane.
const KEYNOTE_LOCK = join(tmpdir(), "silicon-present-keynote.lock");
const PROFILE = `file://${join(WORK_DIR, "lo-profile")}`;

/**
 * Convert `input` with LibreOffice. `to` is a --convert-to target ("pptx", "ppt", "odp", "pdf", or with a filter).
 * Returns the path of the converted file in `outDir`.
 */
export function soffice(input: string, to: string, outDir: string, ext = to.split(":")[0]!): Promise<string> {
  if (!HAVE.soffice()) {
    return Promise.reject(new ConverterError("libreoffice_unavailable", `LibreOffice is not installed at ${SOFFICE}, so this format can't be converted.`, "Install LibreOffice on the converter host or set SOFFICE_PATH.", 501));
  }
  return sofficeQueue(async () => {
    await run(SOFFICE, [`-env:UserInstallation=${PROFILE}`, "--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck", "--convert-to", to, "--outdir", outDir, input], {
      what: "LibreOffice",
      timeoutMs: 240_000,
    });
    const want = join(outDir, basename(input, extname(input)) + "." + ext);
    if (existsSync(want)) return want;
    const found = readdirSync(outDir).find((f) => f.toLowerCase().endsWith("." + ext) && join(outDir, f) !== input);
    if (found) return join(outDir, found);
    throw new ConverterError("conversion_failed", `LibreOffice did not produce a .${ext} file from ${basename(input)}.`, "The file may be damaged, password protected, or in a format LibreOffice can't open.", 422);
  });
}

/** PDF of a presentation with hidden slides included (so page n is slide n). */
export function sofficePdfAllSlides(input: string, outDir: string): Promise<string> {
  return soffice(input, 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"},"ExportNotesPages":{"type":"boolean","value":"false"}}', outDir, "pdf");
}

const KEYNOTE_HINT = "Keynote export and import need a Mac converter host with Keynote installed and Automation permission for Keynote (System Settings > Privacy & Security > Automation). Export as .pptx and open that in Keynote instead.";

let keynoteN = 0;

async function osa(lines: string[], args: string[] = [], timeoutMs = 20_000): Promise<string> {
  const flat = lines.flatMap((l) => ["-e", l]);
  return (await run("osascript", [...flat, ...args], { what: "Keynote", timeoutMs })).stdout.trim();
}

/**
 * Text of an alert or sheet Keynote is showing (dismissed with OK), or null. Needs Accessibility for System Events;
 * if that isn't allowed we can't see alerts and rely on time limits instead.
 */
async function keynoteAlert(): Promise<string | null> {
  try {
    const out = await osa(
      [
        'tell application "System Events" to tell process "Keynote"',
        'set msg to ""',
        "repeat with w in (every window)",
        // only real alerts (they have an OK button); progress panels ("Opening ...") have Cancel and are left alone
        'if subrole of w is "AXDialog" and (exists button "OK" of w) then',
        "repeat with t in (every static text of w)",
        'set msg to msg & (value of t as text) & " "',
        "end repeat",
        'click button "OK" of w',
        "end if",
        "repeat with sh in (every sheet of w)",
        'if exists button "OK" of sh then',
        "repeat with t in (every static text of sh)",
        'set msg to msg & (value of t as text) & " "',
        "end repeat",
        'click button "OK" of sh',
        "end if",
        "end repeat",
        "end repeat",
        "return msg",
        "end tell",
      ],
      [],
      8_000,
    );
    return out || null;
  } catch {
    return null;
  }
}

/** Alerts that mean the file itself can't be used (others, like a movie Keynote can't convert, are warnings). */
function isFatalAlert(text: string): boolean {
  return /can.t be imported|couldn.t be opened|can.t be opened|isn.t a valid|damaged/i.test(text) && !/movie|audio|sound|video|font/i.test(text);
}

/** Close documents left open by converter processes that no longer exist (their names carry the pid). */
async function closeOrphans(): Promise<void> {
  const names = await osa(['tell application "Keynote" to get name of every document']);
  for (const name of names.split(", ")) {
    const m = /^silicon-present-(\d+)-/.exec(name.trim());
    if (!m) continue;
    let alive = true;
    try {
      process.kill(Number(m[1]), 0);
    } catch {
      alive = false;
    }
    if (!alive) await osa(['tell application "Keynote"', `close (first document whose name is "${name.trim().replace(/"/g, "")}") saving no`, "end tell"]).catch(() => undefined);
  }
}

export function keynoteError(error: unknown): ConverterError {
  const msg = error instanceof Error ? error.message : String(error);
  if (error instanceof ConverterError && error.code !== "tool_failed") return error;
  // Missing scripting classes (-1728/-1708), corrupt input and application bugs
  // are conversion failures, not evidence that Automation permission was denied.
  if (/-1743|-10004|not authori[sz]ed to send Apple events|not allowed to send Apple events/i.test(msg)) {
    return new ConverterError("keynote_unavailable", "Keynote is installed but this converter isn't allowed to control it.", KEYNOTE_HINT, 501);
  }
  return new ConverterError("keynote_failed", `Keynote could not convert the file: ${msg.slice(0, 400)}`, "Check Keynote's scripting support and that the file opens in Keynote; otherwise use .pptx.", 422);
}

/**
 * Drive Keynote. The input is opened through LaunchServices (`open -g -a Keynote`), because Keynote's sandbox only
 * lets it read files handed to it that way (AppleScript's own `open` fails with "can't be imported"); saving and
 * exporting through AppleScript is allowed. A copy with a unique name identifies our document among any the Carbon
 * has open; we close only that one, and quit Keynote afterwards only if it wasn't running and has nothing else open.
 */
async function keynote(action: "save" | "export-pptx", input: string, output: string): Promise<{ path: string; warnings: string[] }> {
  if (!HAVE.keynote()) {
    throw new ConverterError("keynote_unavailable", `Keynote is not installed on this converter host (${KEYNOTE_APP}), so .key files can't be made or read here.`, KEYNOTE_HINT, 501);
  }
  return keynoteQueue(() => withKeynoteLock(KEYNOTE_LOCK, async () => {
    const stem = `silicon-present-${process.pid}-${++keynoteN}-${Date.now().toString(36)}`;
    const src = join(dirname(output), stem + extname(input));
    copyFileSync(input, src);
    let wasRunning = true;
    const warnings: string[] = [];
    try {
      wasRunning = (await osa(['return application "Keynote" is running'])) === "true";
      if (wasRunning) {
        await keynoteAlert(); // an alert left over from an earlier job would otherwise look like ours
        await closeOrphans();
      }
      // -ApplePersistenceIgnoreState: a fresh Keynote must not try to reopen documents from an earlier session
      await run("open", ["-g", "-a", KEYNOTE_APP, src, "--args", "-ApplePersistenceIgnoreState", "YES"], { what: "Keynote", timeoutMs: 30_000 });
      const deadline = Date.now() + 150_000;
      for (;;) {
        // A successful empty result means the file is still opening. A scripting
        // error must reach the caller; swallowing it hid broken native scripting
        // behind a misleading 150-second file-opening timeout.
        const names = await osa(['tell application "Keynote" to get name of every document']);
        if (names.includes(stem)) break;
        const alert = await keynoteAlert();
        if (alert && isFatalAlert(alert)) throw new ConverterError("keynote_failed", `Keynote could not open the file: ${alert.trim()}`, "Check the file opens in Keynote; otherwise use .pptx.", 422);
        if (alert) warnings.push(`Keynote: ${alert.trim()}`);
        if (Date.now() > deadline) throw new ConverterError("converter_timeout", "Keynote did not open the file within 150 s.", "Try again; if it keeps failing, use .pptx.", 504);
        await new Promise((r) => setTimeout(r, 700));
      }
      const act = action === "save" ? "save theDoc in (POSIX file (item 2 of argv))" : "export theDoc to (POSIX file (item 2 of argv)) as Microsoft PowerPoint";
      // Keynote can stop on a sheet ("This movie can't be added") while saving or exporting: watch for those,
      // dismiss them and report them, while the AppleScript waits
      let finished = false;
      const job = run(
        "osascript",
        [
          "-e", "on run argv",
          "-e", "with timeout of 300 seconds",
          "-e", 'tell application "Keynote"',
          "-e", "set theDoc to first document whose name starts with (item 1 of argv)",
          "-e", act,
          "-e", "close theDoc saving no",
          "-e", "end tell",
          "-e", "end timeout",
          "-e", "end run",
          stem,
          output,
        ],
        { what: "Keynote", timeoutMs: 320_000 },
      ).finally(() => {
        finished = true;
      });
      while (!finished) {
        await Promise.race([job.catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
        if (finished) break;
        const alert = await keynoteAlert();
        if (alert) warnings.push(`Keynote: ${alert.trim()}`);
      }
      await job;
    } catch (e) {
      throw keynoteError(e);
    } finally {
      // never leave our document open, even when something failed
      await osa(['tell application "Keynote"', `repeat while (count of (every document whose name starts with "${stem}")) > 0`, `close (first document whose name starts with "${stem}") saving no`, "end repeat", "end tell"]).catch(() => undefined);
      if (!wasRunning) {
        await osa(['tell application "Keynote"', "if (count of documents) is 0 then quit", "end tell"]).catch(() => undefined);
      }
    }
    if (!existsSync(output)) throw new ConverterError("keynote_failed", "Keynote finished without writing the file.", KEYNOTE_HINT, 422);
    return { path: output, warnings };
  }));
}

export function pptxToKey(pptx: string, out: string): Promise<{ path: string; warnings: string[] }> {
  return keynote("save", pptx, out);
}

export function keyToPptx(key: string, out: string): Promise<{ path: string; warnings: string[] }> {
  return keynote("export-pptx", key, out);
}

export { renameSync };
