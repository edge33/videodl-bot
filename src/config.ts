import { isAbsolute, resolve } from "node:path";
import { type DownloadLimits, defaultLimits } from "./download-limits.ts";

export interface Config {
  token: string;
  allowedUserId: number;
}

export class ConfigurationError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const token = env.TELEGRAM_BOT_API_KEY?.trim();
  if (!token) {
    throw new ConfigurationError(
      "Set TELEGRAM_BOT_API_KEY to your Telegram bot token.",
    );
  }

  const userId = env.TELEGRAM_ALLOWED_USER_ID?.trim();
  if (
    !userId ||
    !/^[1-9]\d*$/.test(userId) ||
    !Number.isSafeInteger(Number(userId))
  ) {
    throw new ConfigurationError(
      "Set TELEGRAM_ALLOWED_USER_ID to your positive numeric Telegram user ID.",
    );
  }

  return { token, allowedUserId: Number(userId) };
}

export function loadStorageConfig(env: NodeJS.ProcessEnv): {
  downloadDir: string;
} {
  const downloadDir = env.DOWNLOAD_DIR?.trim() || resolve("downloads");
  if (!isAbsolute(downloadDir)) {
    throw new ConfigurationError("DOWNLOAD_DIR must be an absolute path.");
  }
  return { downloadDir };
}

export function loadDownloadLimits(env: NodeJS.ProcessEnv): DownloadLimits {
  const read = (name: string, fallback: number) => {
    const value = env[name]?.trim();
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new ConfigurationError(`${name} must be a positive safe integer.`);
    return Number(value);
  };
  return {
    durationSeconds: read(
      "MAX_DURATION_SECONDS",
      defaultLimits.durationSeconds,
    ),
    fileBytes: read("MAX_FILE_BYTES", defaultLimits.fileBytes),
    reserveBytes: read("FREE_SPACE_RESERVE_BYTES", defaultLimits.reserveBytes),
    deadlineMs: read("JOB_DEADLINE_MS", defaultLimits.deadlineMs),
  };
}
