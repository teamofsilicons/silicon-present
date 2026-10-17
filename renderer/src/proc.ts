import { spawn } from "node:child_process";
import { ConverterError } from "./errors";

/** Run a program with a time limit; resolves with stdout, rejects with a ConverterError carrying stderr. */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number; cwd?: string; what: string; env?: NodeJS.ProcessEnv } ): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ConverterError("converter_timeout", `${opts.what} took longer than ${Math.round((opts.timeoutMs ?? 0) / 1000)} s and was stopped.`, "Try again with a smaller file, or split the deck.", 504));
    }, opts.timeoutMs ?? 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ConverterError("tool_missing", `${opts.what} could not start: ${e.message}.`, `Install it on the converter host (${cmd}).`, 500));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ConverterError("tool_failed", `${opts.what} failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}`, "The file may be damaged or in a version this tool can't read.", 422));
    });
  });
}

/** One-at-a-time queue (LibreOffice and Keynote each run one conversion at a time per process). */
export function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return function <T>(fn: () => Promise<T>): Promise<T> {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}
