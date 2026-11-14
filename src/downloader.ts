import { link, mkdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type DownloadLimits, defaultLimits } from "./download-limits.ts";
import { DownloadError, type ProcessRunner, runProcess } from "./process.ts";
import type { Job, QueueStore } from "./queue.ts";
import type { Downloader } from "./worker.ts";

interface Metadata {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
  live_status?: unknown;
  availability?: unknown;
}
interface Probe {
  format?: { format_name?: string; duration?: string };
  streams?: { codec_type?: string; codec_name?: string; height?: number }[];
}

export interface DownloadOptions {
  directory: string;
  store: QueueStore;
  limits?: DownloadLimits;
  run?: ProcessRunner;
  freeBytes?: () => Promise<number>;
  wait?: (ms: number, signal: AbortSignal) => Promise<unknown>;
  progress?: (job: Job, text: string) => void;
}

export function createDownloader(options: DownloadOptions): Downloader {
  const { directory, store } = options;
  const limits = options.limits ?? defaultLimits;
  const run = options.run ?? runProcess;
  const freeBytes =
    options.freeBytes ??
    (async () => {
      const disk = await statfs(directory);
      return disk.bavail * disk.bsize;
    });
  const wait =
    options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  let spaceCheck: Promise<void> | undefined;
  const checkSpace = (): Promise<void> => {
    spaceCheck ??= (async () => {
      if ((await freeBytes()) < limits.reserveBytes)
        throw new DownloadError("Free-space reserve reached.");
    })().finally(() => {
      spaceCheck = undefined;
    });
    return spaceCheck;
  };

  return async (job, shutdown) => {
    const stage = join(directory, ".staging", String(job.id));
    await mkdir(stage, { recursive: true });
    const startedAt = store.startedAt(job.id, Date.now());
    const deadline = AbortSignal.timeout(
      Math.max(1, limits.deadlineMs - (Date.now() - startedAt)),
    );
    const controller = new AbortController();
    const signal = AbortSignal.any([shutdown, deadline, controller.signal]);
    // Monitoring also covers FFmpeg merging/conversion, which can exceed source size.
    const monitor = setInterval(() => {
      if (spaceCheck) return;
      void checkSpace().catch((error: unknown) => controller.abort(error));
    }, 1000);
    const execute = (
      command: string,
      args: string[],
      onLine?: (line: string) => void,
    ) => run({ command, args, signal, ...(onLine ? { onLine } : {}) });
    const validate = async (path: string) => {
      const file = await stat(path);
      if (!file.isFile() || file.size === 0 || file.size > limits.fileBytes)
        throw new DownloadError(
          "Final artifact is empty or exceeds the file-size limit.",
        );
      const probe = JSON.parse(
        await execute("ffprobe", [
          "-v",
          "error",
          "-show_format",
          "-show_streams",
          "-of",
          "json",
          path,
        ]),
      ) as Probe;
      const streams = probe.streams ?? [];
      const audio = streams.some(
        (s) =>
          s.codec_type === "audio" &&
          s.codec_name === (job.format === "mp3" ? "mp3" : "aac"),
      );
      const video = streams.find((s) => s.codec_type === "video");
      const duration = Number(probe.format?.duration);
      const container = probe.format?.format_name ?? "";
      if (
        !audio ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > limits.durationSeconds ||
        (job.format === "mp3"
          ? !container.includes("mp3") || video !== undefined
          : !container.includes("mp4") ||
            video?.codec_name !== "h264" ||
            !video.height ||
            video.height > (job.format === "mp4_720" ? 720 : 1080))
      )
        throw new DownloadError(
          "Final artifact does not match the requested media policy.",
        );
    };
    const perform = async () => {
      try {
        signal.throwIfAborted();
        // Record the intended name in SQLite before publication; it survives stage cleanup.
        const published = job.filename;
        if (published) {
          try {
            await validate(join(directory, published));
            await rm(stage, { recursive: true, force: true });
            return published;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const common = [
          "--ignore-config",
          "--no-playlist",
          "--no-js-runtimes",
          "--js-runtimes",
          `node:${process.execPath}`,
          "--no-remote-components",
          "--retries",
          "0",
          "--fragment-retries",
          "0",
          "--socket-timeout",
          "30",
        ];
        const url = `https://www.youtube.com/watch?v=${job.video_id}`;
        for (let attempt = job.retry_count; ; attempt++) {
          try {
            signal.throwIfAborted();
            await checkSpace();
            const metadata = JSON.parse(
              await execute("yt-dlp", [
                ...common,
                "--dump-single-json",
                "--skip-download",
                "--",
                url,
              ]),
            ) as Metadata;
            if (
              metadata.id !== job.video_id ||
              typeof metadata.title !== "string" ||
              typeof metadata.duration !== "number" ||
              !Number.isFinite(metadata.duration) ||
              metadata.duration <= 0 ||
              metadata.duration > limits.durationSeconds ||
              !["not_live", "was_live"].includes(
                String(metadata.live_status),
              ) ||
              !["public", "unlisted"].includes(String(metadata.availability))
            )
              throw new DownloadError(
                "Source is unavailable, restricted, live, or exceeds the duration limit.",
              );
            const title =
              metadata.title
                .normalize("NFKC")
                .replace(/[^a-zA-Z0-9 _-]/g, "")
                .trim()
                .slice(0, 80) || "video";
            const extension = job.format === "mp3" ? "mp3" : "mp4";
            const filename = `${title} [${job.video_id}] ${job.format}-${job.id}.${extension}`;
            const cap = job.format === "mp4_720" ? 720 : 1080;
            const format =
              job.format === "mp3"
                ? [
                    "-f",
                    "bestaudio/best",
                    "-x",
                    "--audio-format",
                    "mp3",
                    "--audio-quality",
                    "320K",
                  ]
                : [
                    "-f",
                    `bestvideo[vcodec^=avc1][height<=${cap}]+bestaudio[acodec^=mp4a]/best[vcodec^=avc1][acodec^=mp4a][height<=${cap}]`,
                    "--merge-output-format",
                    "mp4",
                    "--remux-video",
                    "mp4",
                  ];
            // A killed FFmpeg can leave a readable but incomplete MP3. yt-dlp
            // treats that output as finished, so rebuild it while retaining
            // source audio and .part downloads for supported resumption.
            if (job.format === "mp3")
              await rm(join(stage, "media.mp3"), { force: true });
            options.progress?.(job, "Downloading.");
            await execute(
              "yt-dlp",
              [
                ...common,
                ...format,
                "--continue",
                "--newline",
                "--progress-template",
                "download:progress:%(progress._percent_str)s",
                "--max-filesize",
                String(limits.fileBytes),
                "-o",
                join(stage, "media.%(ext)s"),
                "--",
                url,
              ],
              (line) => {
                const match = /^progress:\s*(\d+(?:\.\d+)?)%/.exec(line);
                if (match) options.progress?.(job, `Downloading ${match[1]}%.`);
                if (/^\[(Merger|ExtractAudio|VideoRemuxer)\]/.test(line))
                  options.progress?.(job, "Processing.");
              },
            );
            options.progress?.(job, "Processing and validating.");
            const artifact = join(stage, `media.${extension}`);
            await checkSpace();
            await validate(artifact);
            signal.throwIfAborted();
            store.preparePublication(job.id, filename);
            // link is atomic and fails on an existing destination; rename would overwrite.
            await link(artifact, join(directory, filename));
            await rm(stage, { recursive: true, force: true });
            return filename;
          } catch (error) {
            if (
              signal.aborted ||
              !(error instanceof DownloadError) ||
              !error.transient ||
              attempt >= 2
            )
              throw error;
            store.retry(job.id);
            await wait(attempt === 0 ? 10000 : 30000, signal);
          }
        }
      } catch (error) {
        if (!shutdown.aborted || store.get(job.id)?.state === "cancelled")
          await rm(stage, { recursive: true, force: true });
        if (deadline.aborted)
          throw new DownloadError("Active job deadline exceeded.");
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      }
    };
    return perform().finally(() => clearInterval(monitor));
  };
}
