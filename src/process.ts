import { spawn } from "node:child_process";

export class DownloadError extends Error {}

export interface ProcessRequest {
  command: string;
  args: string[];
  signal: AbortSignal;
  onLine?: (line: string) => void;
}
export type ProcessRunner = (request: ProcessRequest) => Promise<string>;

// POSIX process groups include yt-dlp's FFmpeg and JavaScript children.
export const runProcess: ProcessRunner = ({
  command,
  args,
  signal,
  onLine,
}) => {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let output = "";
    let outputBytes = 0;
    let outputError: DownloadError | undefined;
    let pending = "";
    const stop = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        // The group can exit between abort delivery and the kill syscall.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          reject(new DownloadError("Could not terminate media process group."));
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      outputBytes += data.length;
      if (outputBytes > 4 * 1024 * 1024) {
        outputError = new DownloadError(
          "Media tool stdout exceeded the 4 MiB limit.",
        );
        stop();
        return;
      }
      output += data.toString();
      pending += data.toString();
      const lines = pending.split("\n");
      pending = lines.pop() as string;
      for (const line of lines) onLine?.(line);
      pending = pending.slice(-8192);
    });
    // Drain stderr without retaining credential-bearing tool diagnostics.
    child.stderr.resume();
    child.once("error", () => {
      signal.removeEventListener("abort", stop);
      reject(new DownloadError("Required media tool could not start."));
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) return reject(signal.reason);
      if (outputError) return reject(outputError);
      if (code === 0) return resolve(output);
      reject(
        new DownloadError(
          "Media unavailable or incompatible; check installed media tools.",
        ),
      );
    });
  });
};
