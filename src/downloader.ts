import { randomUUID } from "node:crypto";
import { link, mkdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { type DownloadLimits, defaultLimits } from "./download-limits.ts";
import { DownloadError, type ProcessRunner, runProcess } from "./process.ts";
import type { Format } from "./video.ts";

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

function failureReason(error: unknown): string {
  if (error instanceof DownloadError) return error.message;
  if (error instanceof SyntaxError)
    return "Invalid JSON returned by media tool.";
  return "Unexpected download failure.";
}

export interface DownloadRequest {
  videoId: string;
  format: Format;
}
export type Downloader = (
  request: DownloadRequest,
  signal: AbortSignal,
  progress?: (text: string) => void,
) => Promise<string>;

export interface DownloadOptions {
  directory: string;
  limits?: DownloadLimits;
  run?: ProcessRunner;
  freeBytes?: () => Promise<number>;
}

export function createDownloader(options: DownloadOptions): Downloader {
  const { directory } = options;
  const limits = options.limits ?? defaultLimits;
  const run = options.run ?? runProcess;
  const freeBytes =
    options.freeBytes ??
    (async () => {
      const disk = await statfs(directory);
      return disk.bavail * disk.bsize;
    });
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

  return async (job, shutdown, progress) => {
    const id = randomUUID();
    let phase = "preparation";
    const log = (
      event: string,
      details: Record<string, string | number> = {},
    ) => {
      console.info(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event,
          downloadId: id,
          format: job.format,
          phase,
          ...details,
        }),
      );
    };
    log("download_started");
    const stage = join(directory, ".staging", id);
    const deadline = AbortSignal.timeout(limits.deadlineMs);
    const controller = new AbortController();
    const signal = AbortSignal.any([shutdown, deadline, controller.signal]);
    // Monitoring also covers FFmpeg merging/conversion, which can exceed source size.
    const monitor = setInterval(() => {
      if (spaceCheck) return;
      void checkSpace().catch((error: unknown) => controller.abort(error));
    }, 1000);
    const execute = async (
      command: string,
      args: string[],
      onLine?: (line: string) => void,
    ) => {
      const started = Date.now();
      log("media_tool_started", { tool: command });
      try {
        const output = await run({
          command,
          args,
          signal,
          ...(onLine ? { onLine } : {}),
        });
        log("media_tool_completed", {
          tool: command,
          elapsedMs: Date.now() - started,
          stdoutBytes: Buffer.byteLength(output),
        });
        return output;
      } catch (error) {
        log("media_tool_failed", {
          tool: command,
          elapsedMs: Date.now() - started,
        });
        throw error;
      }
    };
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
        await mkdir(stage, { recursive: true });
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
          "--extractor-retries",
          "0",
          "--file-access-retries",
          "0",
          "--abort-on-unavailable-fragments",
          "--socket-timeout",
          "30",
        ];
        const url = `https://www.youtube.com/watch?v=${job.videoId}`;
        signal.throwIfAborted();
        phase = "metadata";
        log("download_phase_started");
        await checkSpace();
        const metadata = JSON.parse(
          await execute("yt-dlp", [
            ...common,
            // Full metadata can exceed the process output buffer for videos
            // with many audio tracks; only request fields used by policy.
            "--print",
            "%(.{id,title,duration,live_status,availability})j",
            "--skip-download",
            "--",
            url,
          ]),
        ) as Metadata;
        if (
          metadata.id !== job.videoId ||
          typeof metadata.title !== "string" ||
          typeof metadata.duration !== "number" ||
          !Number.isFinite(metadata.duration) ||
          metadata.duration <= 0 ||
          metadata.duration > limits.durationSeconds ||
          !["not_live", "was_live"].includes(String(metadata.live_status)) ||
          !["public", "unlisted"].includes(String(metadata.availability))
        )
          throw new DownloadError(
            "Source is unavailable, restricted, live, or exceeds the duration limit.",
          );
        log("metadata_validated", { durationSeconds: metadata.duration });
        const title =
          metadata.title
            .normalize("NFKC")
            .replace(/[^a-zA-Z0-9 _-]/g, "")
            .trim()
            .slice(0, 80) || "video";
        const extension = job.format === "mp3" ? "mp3" : "mp4";
        const filename = `${title} [${job.videoId}] ${job.format}-${id}.${extension}`;
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
        phase = "download";
        log("download_phase_started");
        await execute(
          "yt-dlp",
          [
            ...common,
            ...format,
            "--no-continue",
            "--newline",
            "--progress",
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
            if (match) progress?.(`Downloading ${match[1]}%.`);
            if (/^\[(Merger|ExtractAudio|VideoRemuxer)\]/.test(line)) {
              progress?.("Processing.");
              phase = "processing";
              log("download_phase_started");
            }
          },
        );
        phase = "validation";
        log("download_phase_started");
        const artifact = join(stage, `media.${extension}`);
        await checkSpace();
        await validate(artifact);
        signal.throwIfAborted();
        phase = "publication";
        log("download_phase_started");
        // link is atomic and fails on an existing destination; rename would overwrite.
        await link(artifact, join(directory, filename));
        return filename;
      } catch (error) {
        if (deadline.aborted)
          throw new DownloadError("Active job deadline exceeded.");
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      }
    };
    return perform()
      .finally(async () => {
        clearInterval(monitor);
        await rm(stage, { recursive: true, force: true });
        log("temporary_files_removed");
      })
      .then((filename) => {
        log("download_completed");
        return filename;
      })
      .catch((error: unknown) => {
        if (shutdown.aborted) {
          log("download_interrupted");
        } else {
          log("download_failed", { reason: failureReason(error) });
        }
        throw error;
      });
  };
}
