import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { ConverterError } from "./errors";

/** A kernel lock shared by every converter using this Mac's Keynote application.
 * lockf locks our inherited open file description; keeping the parent descriptor
 * open retains the lock after lockf exits. The kernel releases it on a crash.
 * Never unlink this file: waiters must all lock the same inode.
 */
export async function withKeynoteLock<T>(path: string, fn: () => Promise<T>, timeoutSeconds = 300): Promise<T> {
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/lockf", ["-s", "-t", String(timeoutSeconds), "3"], {
        stdio: ["ignore", "ignore", "pipe", file.fd],
      });
      let stderr = "";
      child.stderr!.on("data", (data) => { stderr += data; });
      child.once("error", (error) => reject(new ConverterError("keynote_failed", `Could not acquire the Keynote lock: ${error.message}`, "Check the converter host's lockf installation.", 500)));
      child.once("close", (code) => {
        if (code === 0) resolve();
        else if (code === 75) reject(new ConverterError("converter_timeout", "Another converter is still using Keynote.", "Try again after the other conversion finishes.", 504));
        else reject(new ConverterError("keynote_failed", `Could not acquire the Keynote lock (exit ${code}): ${stderr.trim().slice(0, 300)}`, "Check the converter host's lockf installation.", 500));
      });
    });
    return await fn();
  } finally {
    await file.close();
  }
}
