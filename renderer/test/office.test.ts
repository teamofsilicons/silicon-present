import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConverterError } from "../src/errors";
import { withKeynoteLock } from "../src/keynote-lock";
import { keynoteError } from "../src/office";

test("Keynote scripting failures preserve their cause instead of claiming permission denial", () => {
  for (const message of ["Can't get every document. (-1728)", "every document doesn't understand the count message. (-1708)", "File permission denied"]) {
    const error = keynoteError(new ConverterError("tool_failed", message, ""));
    assert.equal(error.code, "keynote_failed");
    assert.equal(error.status, 422);
    assert.ok(error.message.includes(message));
  }
  assert.equal(keynoteError(new Error("Not authorized to send Apple events. (-1743)")).code, "keynote_unavailable");
  const timeout = new ConverterError("converter_timeout", "Actual timeout", "", 504);
  assert.equal(keynoteError(timeout), timeout);
});

function worker(path: string) {
  const source = `
    import { withKeynoteLock } from ${JSON.stringify(new URL("../src/keynote-lock.ts", import.meta.url).href)};
    process.stdin.resume();
    await withKeynoteLock(process.argv[1], async () => {
      process.stdout.write('locked\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
    }, 10);
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, path], { stdio: ["pipe", "pipe", "pipe"] });
  let acquired = false;
  let stderr = "";
  const done = new Promise<number | null>((resolve) => child.once("close", resolve));
  child.stderr.on("data", data => { stderr += data; });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", data => {
      if (String(data).includes("locked")) { acquired = true; resolve(); }
    });
    child.once("error", reject);
    child.once("close", code => { if (!acquired) reject(new Error(`Lock worker exited ${code}: ${stderr}`)); });
  });
  return { child, ready, done, acquired: () => acquired };
}

test("Keynote lock excludes other converter processes and is released after a crash", { skip: process.platform !== "darwin", timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "present-keynote-lock-test-"));
  const path = join(dir, "keynote.lock");
  const first = worker(path);
  let second: ReturnType<typeof worker> | undefined;
  try {
    await first.ready;
    await assert.rejects(withKeynoteLock(path, async () => assert.fail("a different process already owns Keynote"), 0), (error: unknown) => error instanceof ConverterError && error.code === "converter_timeout");
    second = worker(path);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(second.acquired(), false, "the second converter must wait while the first holds the lock");
    first.child.kill("SIGKILL");
    await first.done;
    await second.ready;
    second.child.stdin.write("release\n");
    assert.equal(await second.done, 0);
    // Exceptions release the same persistent lock inode too.
    await assert.rejects(withKeynoteLock(path, async () => { throw new Error("conversion failed"); }), /conversion failed/);
    assert.equal(await withKeynoteLock(path, async () => "next conversion"), "next conversion");
  } finally {
    first.child.kill("SIGKILL");
    second?.child.kill("SIGKILL");
    await Promise.all([first.done, second?.done]);
    await rm(dir, { recursive: true, force: true });
  }
});
