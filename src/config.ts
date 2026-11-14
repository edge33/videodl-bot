export interface Config {
  token: string;
  allowedUserId: number;
}

export class ConfigurationError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const token = env.TELEGRAM_BOT_API_KEY?.trim();
  if (!token || !/^[1-9]\d*:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new ConfigurationError(
      "Set TELEGRAM_BOT_API_KEY to a valid Telegram bot token.",
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
