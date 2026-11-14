import assert from "node:assert/strict";
import { test } from "node:test";
import { DownloadError, runProcess } from "../src/process.ts";

const signal = () => new AbortController().signal;

test("executes argument arrays literally and reports progress lines", async () => {
  const lines: string[] = [];
  const result = await runProcess({
    command: process.execPath,
    args: [
      "-e",
      "console.log(process.argv[1]); process.stdout.write('partial')",
      "$(literal); argument",
    ],
    signal: signal(),
    onLine: (line) => lines.push(line),
  });
  assert.equal(result, "$(literal); argument\npartial");
  assert.deepEqual(lines, ["$(literal); argument"]);
});

test("can discard progress while capturing output", async () => {
  assert.equal(
    await runProcess({
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      signal: signal(),
    }),
    "ok\n",
  );
});

test("reports missing tools with a safe error", async () => {
  await assert.rejects(
    runProcess({ command: "/nonexistent/videodl", args: [], signal: signal() }),
    /could not start/,
  );
});

test("classifies transient network failures without exposing stderr", async () => {
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "console.error('secret HTTP Error 503'); process.exit(1)"],
      signal: signal(),
    }),
    (e: unknown) =>
      e instanceof DownloadError &&
      e.transient &&
      !e.message.includes("secret"),
  );
});

test("classifies permanent tool failures", async () => {
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "console.error('secret unavailable'); process.exit(1)"],
      signal: signal(),
    }),
    (e: unknown) => e instanceof DownloadError && !e.transient,
  );
});

test("aborted signals never start a subprocess", () => {
  assert.throws(
    () =>
      runProcess({
        command: process.execPath,
        args: [],
        signal: AbortSignal.abort(),
      }),
    { name: "AbortError" },
  );
});

test("cancellation kills the process group including a child that ignores SIGTERM", async () => {
  const stop = new AbortController();
  let childPid = 0;
  const running = runProcess({
    command: process.execPath,
    args: [
      "-e",
      `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:'inherit'}); console.log(child.pid); setInterval(()=>{},1000);`,
    ],
    signal: stop.signal,
    onLine: (line) => {
      childPid = Number(line);
      stop.abort();
    },
  });
  await assert.rejects(running, { name: "AbortError" });
  assert(childPid > 0);
  // A reaped process is gone; an orphan zombie is also no longer executable.
  const { readFile } = await import("node:fs/promises");
  try {
    assert.match(await readFile(`/proc/${childPid}/stat`, "utf8"), /\) Z /);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
});

test("handles a process group disappearing during cancellation", async (t) => {
  const stop = new AbortController();
  const original = process.kill;
  t.mock.method(process, "kill", (pid: number, sig: NodeJS.Signals) => {
    original(pid, sig);
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      signal: stop.signal,
      onLine: () => stop.abort(),
    }),
    { name: "AbortError" },
  );
});

test("reports unexpected termination errors safely", async (t) => {
  const stop = new AbortController();
  const original = process.kill;
  t.mock.method(process, "kill", (pid: number, sig: NodeJS.Signals) => {
    original(pid, sig);
    throw Object.assign(new Error("secret"), { code: "EPERM" });
  });
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      signal: stop.signal,
      onLine: () => stop.abort(),
    }),
    /Could not terminate/,
  );
});

test("cancellation before a missing tool spawns has no process group to kill", async () => {
  const stop = new AbortController();
  const running = runProcess({
    command: "/nonexistent/videodl",
    args: [],
    signal: stop.signal,
  });
  stop.abort();
  await assert.rejects(running, /could not start/);
});
