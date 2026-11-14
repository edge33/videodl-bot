import { spawn } from "node:child_process";

export class DownloadError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient = false) {
    super(message);
    this.transient = transient;
  }
}

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
    let errors = "";
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
      output = (output + data.toString()).slice(-4 * 1024 * 1024);
      pending += data.toString();
      const lines = pending.split("\n");
      pending = lines.pop() as string;
      for (const line of lines) onLine?.(line);
      pending = pending.slice(-8192);
    });
    child.stderr.on("data", (data: Buffer) => {
      errors = (errors + data.toString()).slice(-8192);
    });
    child.once("error", () => {
      signal.removeEventListener("abort", stop);
      reject(new DownloadError("Required media tool could not start."));
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) return reject(signal.reason);
      if (code === 0) return resolve(output);
      const transient =
        /HTTP Error (429|5\d\d)|timed? out|Temporary failure|Connection (reset|refused)|network is unreachable/i.test(
          errors,
        );
      reject(
        new DownloadError(
          transient
            ? "Temporary download connection failure."
            : "Media unavailable or incompatible; check installed media tools.",
          transient,
        ),
      );
    });
  });
};
