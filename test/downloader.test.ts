import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { defaultLimits } from "../src/download-limits.ts";
import type { DownloadRequest } from "../src/downloader.ts";
import { createDownloader, type DownloadOptions } from "../src/downloader.ts";
import { DownloadError, type ProcessRunner } from "../src/process.ts";

async function fixture(
  t: TestContext,
  format: DownloadRequest["format"] = "mp3",
) {
  const logs: Record<string, unknown>[] = [];
  t.mock.method(console, "info", (line: string) => logs.push(JSON.parse(line)));
  const directory = await mkdtemp(join(tmpdir(), "download-"));
  const job: DownloadRequest = { videoId: "abcDEF_12-3", format };
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const calls: string[][] = [];
  const metadata = {
    id: job.videoId,
    title: "A / title ♥",
    duration: 60,
    live_status: "not_live",
    availability: "public",
  };
  const probe = {
    format: {
      format_name: format === "mp3" ? "mp3" : "mov,mp4",
      duration: "60",
    },
    streams: [
      { codec_type: "audio", codec_name: format === "mp3" ? "mp3" : "aac" },
      ...(format === "mp3"
        ? []
        : [{ codec_type: "video", codec_name: "h264", height: 360 }]),
    ],
  };
  const run: ProcessRunner = async ({ command, args, signal, onLine }) => {
    signal.throwIfAborted();
    calls.push([command, ...args]);
    if (command === "ffprobe") return JSON.stringify(probe);
    if (args.includes("--print")) return JSON.stringify(metadata);
    onLine?.("noise");
    onLine?.("progress: 25.5%");
    onLine?.("[Merger] Merging formats");
    await writeFile(
      (args[args.indexOf("-o") + 1] as string).replace(
        "%(ext)s",
        format === "mp3" ? "mp3" : "mp4",
      ),
      "media",
    );
    return "";
  };
  const options: DownloadOptions = {
    directory,
    run,
    freeBytes: async () => 10 * 1024 ** 3,
  };
  return { directory, job, calls, metadata, probe, options, run, logs };
}

test("logs job phases and tool timing without exposing titles, URLs, or raw output", async (t) => {
  const f = await fixture(t);
  f.metadata.title = "private-title-secret";
  await createDownloader(f.options)(f.job, new AbortController().signal);
  assert.deepEqual(
    f.logs
      .filter((entry) => entry.event === "download_phase_started")
      .map((entry) => entry.phase),
    ["metadata", "download", "processing", "validation", "publication"],
  );
  assert.equal(f.logs[0]?.event, "download_started");
  assert.equal(f.logs.at(-1)?.event, "download_completed");
  for (const entry of f.logs) {
    assert.match(String(entry.downloadId), /^[0-9a-f-]{36}$/);
    assert.equal(entry.format, f.job.format);
    assert.equal(
      new Date(String(entry.timestamp)).toISOString(),
      entry.timestamp,
    );
  }
  const tools = f.logs.filter(
    (entry) => entry.event === "media_tool_completed",
  );
  assert.equal(tools.length, 3);
  for (const entry of tools) {
    assert(Number(entry.elapsedMs) >= 0);
    assert(Number(entry.stdoutBytes) >= 0);
  }
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /private-title-secret|https:|abcDEF_12-3/,
  );
});

test("logs invalid metadata JSON safely with the failing phase", async (t) => {
  const f = await fixture(t);
  f.options.run = async () => "secret-token-and-payload";
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    SyntaxError,
  );
  assert.equal(f.logs.at(-1)?.event, "download_failed");
  assert.equal(f.logs.at(-1)?.phase, "metadata");
  assert.equal(f.logs.at(-1)?.reason, "Invalid JSON returned by media tool.");
  assert.doesNotMatch(JSON.stringify(f.logs), /secret-token-and-payload/);
});

test("logs unexpected tool failures without serializing raw errors", async (t) => {
  const f = await fixture(t);
  f.options.run = async () => {
    throw new Error("secret-token-and-payload");
  };
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    /secret-token-and-payload/,
  );
  assert(
    f.logs.some(
      (entry) => entry.event === "media_tool_failed" && entry.tool === "yt-dlp",
    ),
  );
  assert.equal(f.logs.at(-1)?.reason, "Unexpected download failure.");
  assert.doesNotMatch(JSON.stringify(f.logs), /secret-token-and-payload/);
});

for (const format of ["mp3", "mp4_720", "mp4_1080"] as const) {
  test(`publishes validated ${format} with bounded sanitized name and lower-resolution fallback`, async (t) => {
    const f = await fixture(t, format);
    const name = await createDownloader(f.options)(
      f.job,
      new AbortController().signal,
    );
    assert.match(name, /^A {2}title \[abcDEF_12-3\]/);
    assert.equal(await readFile(join(f.directory, name), "utf8"), "media");
    assert.deepEqual(await readdir(join(f.directory, ".staging")), []);
    const args = f.calls[1] as string[];
    assert(args.includes("--ignore-config"));
    assert(args.includes("--no-playlist"));
    assert(args.includes(format === "mp3" ? "320K" : "--remux-video"));
    if (format !== "mp3")
      assert(
        args.some((a) =>
          a.includes(`height<=${format === "mp4_720" ? 720 : 1080}`),
        ),
      );
  });
}

for (const [field, value] of Object.entries({
  id: "wrong",
  title: null,
  duration: 7201,
  live_status: "is_live",
  availability: "private",
})) {
  test(`rejects source policy violation: ${field}`, async (t) => {
    const f = await fixture(t);
    Object.assign(f.metadata, { [field]: value });
    await assert.rejects(
      createDownloader(f.options)(f.job, new AbortController().signal),
      /Source/,
    );
    assert.equal(f.calls.length, 1);
  });
}

test("rejects absent, invalid, and nonpositive durations", async (t) => {
  const f = await fixture(t);
  for (const duration of [null, "60", -1, 0]) {
    Object.assign(f.metadata, { duration });
    await assert.rejects(
      createDownloader(f.options)(f.job, new AbortController().signal),
      /Source/,
    );
  }
});

test("falls back to a safe title when sanitization removes every character", async (t) => {
  const f = await fixture(t);
  f.metadata.title = "♥";
  assert.match(
    await createDownloader(f.options)(f.job, new AbortController().signal),
    /^video /,
  );
});

test("enforces free-space reserve before metadata", async (t) => {
  const f = await fixture(t);
  f.options.freeBytes = async () => 1;
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    /reserve/,
  );
  assert.equal(f.calls.length, 0);
});

test("rejects oversized converted output", async (t) => {
  const f = await fixture(t);
  f.options.limits = { ...defaultLimits, fileBytes: 1 };
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    /file-size/,
  );
});

test("rejects an empty converted output", async (t) => {
  const f = await fixture(t);
  f.options.run = async (request) => {
    const result = await f.run(request);
    if (request.args.includes("-o"))
      await writeFile(
        (request.args[request.args.indexOf("-o") + 1] as string).replace(
          "%(ext)s",
          "mp3",
        ),
        "",
      );
    return result;
  };
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    /empty/,
  );
});

for (const format of ["mp3", "mp4_720"] as const) {
  test(`rejects invalid ${format} probe results`, async (t) => {
    const f = await fixture(t, format);
    for (const probe of [
      {},
      { format: {} },
      { format: { format_name: "mp3", duration: "no" }, streams: [] },
      { ...f.probe, format: { ...f.probe.format, duration: "0" } },
      { ...f.probe, format: { ...f.probe.format, duration: "7201" } },
      { ...f.probe, format: { ...f.probe.format, format_name: "webm" } },
      {
        ...f.probe,
        streams: [
          { codec_type: "audio", codec_name: "aac" },
          { codec_type: "video", codec_name: "h264", height: 1080 },
        ],
      },
      {
        ...f.probe,
        streams: [
          { codec_type: "audio", codec_name: "aac" },
          { codec_type: "video", codec_name: "vp9" },
        ],
      },
    ]) {
      f.options.run = (r) =>
        r.command === "ffprobe"
          ? Promise.resolve(JSON.stringify(probe))
          : f.run(r);
      await assert.rejects(
        createDownloader(f.options)(f.job, new AbortController().signal),
        /media policy/,
      );
    }
  });
}

test("shutdown removes partial work instead of retaining it", async (t) => {
  const f = await fixture(t);
  const stop = new AbortController();
  f.options.run = async () => {
    stop.abort();
    throw stop.signal.reason;
  };
  await assert.rejects(createDownloader(f.options)(f.job, stop.signal));
  assert.deepEqual(await readdir(join(f.directory, ".staging")), []);
  assert.equal(f.logs.at(-1)?.event, "download_interrupted");
});

test("deadline aborts a running tool and removes staging", async (t) => {
  const f = await fixture(t);
  f.options.limits = { ...defaultLimits, deadlineMs: 20 };
  f.options.run = async ({ signal }) =>
    new Promise((_, reject) => {
      const timer = setTimeout(() => {}, 100);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    /deadline/,
  );
});

test("free-space monitoring aborts long processing", async (t) => {
  const f = await fixture(t);
  let checks = 0;
  f.options.freeBytes = async () => (++checks <= 1 ? 10 * 1024 ** 3 : 0);
  f.options.run = async ({ signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    /reserve/,
  );
});

test("publishes with the default runner when full metadata exceeds its output buffer", async (t) => {
  const f = await fixture(t, "mp4_1080");
  const bin = join(f.directory, "bin");
  await mkdir(bin);
  const { chmod } = await import("node:fs/promises");
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const metadata = ${JSON.stringify(f.metadata)};
// Model a large format/manifest payload, as returned for multilingual videos.
metadata.formats = [{ manifest: 'x'.repeat(5 * 1024 * 1024) }];
if (path.basename(process.argv[1]) === 'ffprobe') {
  console.log(${JSON.stringify(JSON.stringify(f.probe))});
} else if (args.includes('--dump-single-json')) {
  console.log(JSON.stringify(metadata));
} else if (args.includes('--print')) {
  const template = args[args.indexOf('--print') + 1];
  const fields = /^%\\(\\.\\{([^}]+)\\}\\)j$/.exec(template)[1].split(',');
  console.log(JSON.stringify(Object.fromEntries(fields.map(key => [key, metadata[key]]))));
} else {
  fs.writeFileSync(args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4'), 'fixture');
}
`;
  for (const name of ["yt-dlp", "ffprobe"]) {
    const path = join(bin, name);
    await writeFile(path, script);
    await chmod(path, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  delete f.options.run;
  delete f.options.freeBytes;
  assert.match(
    await createDownloader(f.options)(f.job, new AbortController().signal),
    /mp4_1080-[0-9a-f-]{36}\.mp4$/,
  );
});

test("slow disk checks are shared with publication and never overlap timer ticks", async (t) => {
  const f = await fixture(t);
  const blocked = Promise.withResolvers<number>();
  const checking = Promise.withResolvers<void>();
  const publishing = Promise.withResolvers<void>();
  const releaseDownload = Promise.withResolvers<void>();
  let checks = 0;
  f.options.freeBytes = async () => {
    checks++;
    if (checks === 1) return 10 * 1024 ** 3;
    checking.resolve();
    return blocked.promise;
  };
  f.options.run = async (request) => {
    if (request.args.includes("-o")) await releaseDownload.promise;
    const result = await f.run(request);
    if (request.args.includes("-o")) publishing.resolve();
    return result;
  };
  const running = createDownloader(f.options)(
    f.job,
    new AbortController().signal,
  );
  await checking.promise;
  // Another timer tick occurs while the first check is still unresolved.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(checks, 2);
  releaseDownload.resolve();
  // Publication also waits for that same check rather than starting another.
  await publishing.promise;
  assert.equal(checks, 2);
  blocked.resolve(10 * 1024 ** 3);
  await running;
  assert.equal(checks, 2);
});

test("a failed conversion is attempted once and all temporary files are removed", async (t) => {
  const f = await fixture(t);
  f.options.run = async (request) => {
    const output = await f.run(request);
    if (request.args.includes("-o"))
      throw new DownloadError("Temporary download connection failure.");
    return output;
  };
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    /connection failure/,
  );
  assert.equal(f.calls.filter((call) => call.includes("-o")).length, 1);
  assert.deepEqual(await readdir(join(f.directory, ".staging")), []);
  assert.deepEqual(await readdir(f.directory), [".staging"]);
});

test("repeated requests download again into independent temporary directories", async (t) => {
  const f = await fixture(t);
  const download = createDownloader(f.options);
  const first = await download(f.job, new AbortController().signal);
  const second = await download(f.job, new AbortController().signal);
  assert.notEqual(first, second);
  assert.equal(f.calls.filter((call) => call.includes("-o")).length, 2);
  for (const call of f.calls.filter((call) => call.includes("-o"))) {
    assert(call.includes("--no-continue"));
    assert(!call.includes("--continue"));
  }
  assert.deepEqual(await readdir(join(f.directory, ".staging")), []);
});

test("reports parsed percentage and processing progress", async (t) => {
  const f = await fixture(t);
  const progress: string[] = [];
  await createDownloader(f.options)(
    f.job,
    new AbortController().signal,
    (text) => progress.push(text),
  );
  assert.deepEqual(progress, ["Downloading 25.5%.", "Processing."]);
  assert(f.calls[1]?.includes("--progress-template"));
});
