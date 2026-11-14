import { isAbsolute, resolve } from "node:path";

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
  stateDir: string;
  downloadDir: string;
  maxPending: number;
} {
  const stateDir = env.STATE_DIR?.trim() || resolve("state");
  const downloadDir = env.DOWNLOAD_DIR?.trim() || resolve("downloads");
  if (!isAbsolute(stateDir) || !isAbsolute(downloadDir)) {
    throw new ConfigurationError(
      "STATE_DIR and DOWNLOAD_DIR must be absolute paths.",
    );
  }
  const pending = env.QUEUE_MAX_PENDING?.trim() ?? "20";
  if (!/^[1-9]\d*$/.test(pending) || !Number.isSafeInteger(Number(pending))) {
    throw new ConfigurationError(
      "QUEUE_MAX_PENDING must be a positive safe integer.",
    );
  }
  return { stateDir, downloadDir, maxPending: Number(pending) };
}
