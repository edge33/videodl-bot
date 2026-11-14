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
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import {
  createDownloader,
  type DownloadOptions,
  defaultLimits,
} from "../src/downloader.ts";
import { DownloadError, type ProcessRunner } from "../src/process.ts";
import { type Job, QueueStore } from "../src/queue.ts";

async function fixture(t: TestContext, format: Job["format"] = "mp3") {
  const directory = await mkdtemp(join(tmpdir(), "download-"));
  const db = new DatabaseSync(":memory:");
  const store = new QueueStore(db, directory);
  store.select(store.menu("abcDEF_12-3", 123, 1), 123, format);
  const job = store.claim() as Job;
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const calls: string[][] = [];
  const metadata = {
    id: job.video_id,
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
    if (args.includes("--dump-single-json")) return JSON.stringify(metadata);
    onLine?.("noise");
    onLine?.("progress: 25.5%");
    onLine?.("[Merger] Merging formats");
    await writeFile(
      join(
        directory,
        ".staging",
        String(job.id),
        `media.${format === "mp3" ? "mp3" : "mp4"}`,
      ),
      "media",
    );
    return "";
  };
  const options: DownloadOptions = {
    directory,
    store,
    run,
    freeBytes: async () => 10 * 1024 ** 3,
    wait: async () => {},
  };
  return { directory, store, job, calls, metadata, probe, options, run };
}

for (const format of ["mp3", "mp4_720", "mp4_1080"] as const) {
  test(`publishes validated ${format} with bounded sanitized name and lower-resolution fallback`, async (t) => {
    const f = await fixture(t, format);
    const progress: string[] = [];
    f.options.progress = (_job, text) => progress.push(text);
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
    assert.deepEqual(progress, [
      "Downloading.",
      "Downloading 25.5%.",
      "Processing.",
      "Processing and validating.",
    ]);
  });
}

test("retries transient failures twice with durable counts and 10/30 second backoff", async (t) => {
  const f = await fixture(t);
  let failures = 0;
  const waits: number[] = [];
  f.options.run = async (request) => {
    if (failures++ < 2) throw new DownloadError("network", true);
    return f.run(request);
  };
  f.options.wait = async (ms) => {
    waits.push(ms);
  };
  await createDownloader(f.options)(f.job, new AbortController().signal);
  assert.deepEqual(waits, [10000, 30000]);
  assert.equal(f.store.get(f.job.id)?.retry_count, 2);
});

test("exhausted retries remove staging without publishing", async (t) => {
  const f = await fixture(t);
  f.options.run = async () => {
    throw new DownloadError("network", true);
  };
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    /network/,
  );
  assert.equal(f.store.get(f.job.id)?.retry_count, 2);
  assert.deepEqual(await readdir(join(f.directory, ".staging")), []);
});

test("restart does not reset the retry allowance", async (t) => {
  const f = await fixture(t);
  f.job.retry_count = 2;
  f.options.run = async () => {
    throw new DownloadError("network", true);
  };
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    /network/,
  );
  assert.equal(f.store.get(f.job.id)?.retry_count, 0);
});

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
      await writeFile(join(f.directory, ".staging", "1", "media.mp3"), "");
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

test("reconciles publication after a crash without downloading again", async (t) => {
  const f = await fixture(t);
  const stage = join(f.directory, ".staging", "1");
  await mkdir(stage, { recursive: true });
  f.store.preparePublication(f.job.id, "published.mp3");
  f.job.filename = "published.mp3";
  await writeFile(join(f.directory, "published.mp3"), "media");
  assert.equal(
    await createDownloader(f.options)(f.job, new AbortController().signal),
    "published.mp3",
  );
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ["ffprobe"],
  );
});

test("missing published artifact resumes using its stage", async (t) => {
  const f = await fixture(t);
  const stage = join(f.directory, ".staging", "1");
  await mkdir(stage, { recursive: true });
  f.store.preparePublication(f.job.id, "missing.mp3");
  f.job.filename = "missing.mp3";
  await createDownloader(f.options)(f.job, new AbortController().signal);
  assert(f.calls.some((c) => c.includes("--dump-single-json")));
});

test("invalid published artifact fails validation", async (t) => {
  const f = await fixture(t);
  const stage = join(f.directory, ".staging", "1");
  await mkdir(stage, { recursive: true });
  f.store.preparePublication(f.job.id, "published.mp3");
  f.job.filename = "published.mp3";
  await writeFile(join(f.directory, "published.mp3"), "");
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    /empty/,
  );
});

test("never overwrites an existing destination", async (t) => {
  const f = await fixture(t);
  const name = "A  title [abcDEF_12-3] mp3-1.mp3";
  await writeFile(join(f.directory, name), "original");
  await assert.rejects(
    createDownloader(f.options)(f.job, new AbortController().signal),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(join(f.directory, name), "utf8"), "original");
});

test("shutdown preserves partial work for resume", async (t) => {
  const f = await fixture(t);
  const stop = new AbortController();
  f.options.run = async () => {
    stop.abort();
    throw stop.signal.reason;
  };
  await assert.rejects(createDownloader(f.options)(f.job, stop.signal));
  assert.deepEqual(await readdir(join(f.directory, ".staging")), ["1"]);
});

test("owner cancellation removes partial work", async (t) => {
  const f = await fixture(t);
  const stop = new AbortController();
  f.options.run = async () => {
    f.store.cancel(f.job.id);
    stop.abort();
    throw stop.signal.reason;
  };
  await assert.rejects(createDownloader(f.options)(f.job, stop.signal));
  assert.deepEqual(await readdir(join(f.directory, ".staging")), []);
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
  f.options.freeBytes = async () => (++checks <= 2 ? 10 * 1024 ** 3 : 0);
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

test("runs controlled executable tools with the default runner and disk checks", async (t) => {
  const f = await fixture(t);
  const bin = join(f.directory, "bin");
  await mkdir(bin);
  const { chmod } = await import("node:fs/promises");
  const script = `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path'); const args=process.argv.slice(2); if(path.basename(process.argv[1])==='ffprobe') console.log(${JSON.stringify(JSON.stringify(f.probe))}); else if(args.includes('--dump-single-json')) console.log(${JSON.stringify(JSON.stringify(f.metadata))}); else fs.writeFileSync(args[args.indexOf('-o')+1].replace('%(ext)s','mp3'), 'fixture');\n`;
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
  delete f.options.wait;
  assert.match(
    await createDownloader(f.options)(f.job, new AbortController().signal),
    /mp3-1.mp3$/,
  );
});

test("default backoff is interruptible and retains resumable work on shutdown", async (t) => {
  const f = await fixture(t);
  const stop = new AbortController();
  delete f.options.wait;
  f.options.run = async () => {
    setTimeout(() => stop.abort(), 20);
    throw new DownloadError("network", true);
  };
  await assert.rejects(createDownloader(f.options)(f.job, stop.signal), {
    name: "AbortError",
  });
  assert.equal(f.store.get(f.job.id)?.retry_count, 1);
});

test("expired active deadline remains expired after restart", async (t) => {
  const f = await fixture(t);
  f.store.startedAt(f.job.id, Date.now() - defaultLimits.deadlineMs - 1000);
  f.options.run = async ({ signal }) =>
    new Promise((_, reject) => {
      const keepAlive = setTimeout(() => {}, 100);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(keepAlive);
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

test("restart rebuilds interrupted MP3 conversion instead of publishing truncated audio", async (t) => {
  const f = await fixture(t);
  const stage = join(f.directory, ".staging", String(f.job.id));
  const artifact = join(stage, "media.mp3");
  const shutdown = new AbortController();
  f.options.run = async (request) => {
    if (!request.args.includes("-o")) return f.run(request);
    await writeFile(join(stage, "media.webm"), "complete source");
    await writeFile(join(stage, "media.webm.part"), "resumable download");
    await writeFile(artifact, "truncated audio");
    shutdown.abort();
    throw shutdown.signal.reason;
  };
  await assert.rejects(createDownloader(f.options)(f.job, shutdown.signal));
  f.store.recover();
  const recovered = f.store.claim() as Job;
  f.options.run = async (request) => {
    if (!request.args.includes("-o")) return f.run(request);
    // Like yt-dlp, skip conversion if the target MP3 already exists.
    try {
      await readFile(artifact);
      return "already downloaded";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    assert.equal(
      await readFile(join(stage, "media.webm"), "utf8"),
      "complete source",
    );
    assert.equal(
      await readFile(join(stage, "media.webm.part"), "utf8"),
      "resumable download",
    );
    return f.run(request);
  };
  const filename = await createDownloader(f.options)(
    recovered,
    new AbortController().signal,
  );
  assert.equal(await readFile(join(f.directory, filename), "utf8"), "media");
});

test("transient retry rebuilds MP3 output left by the failed attempt", async (t) => {
  const f = await fixture(t);
  const artifact = join(f.directory, ".staging", String(f.job.id), "media.mp3");
  let attempts = 0;
  f.options.run = async (request) => {
    if (!request.args.includes("-o")) return f.run(request);
    if (++attempts === 1) {
      await writeFile(artifact, "truncated audio");
      throw new DownloadError("network", true);
    }
    try {
      await readFile(artifact);
      return "already downloaded";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return f.run(request);
  };
  const filename = await createDownloader(f.options)(
    f.job,
    new AbortController().signal,
  );
  assert.equal(await readFile(join(f.directory, filename), "utf8"), "media");
  assert.equal(f.store.get(f.job.id)?.retry_count, 1);
});
