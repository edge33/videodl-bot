import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError, loadConfig } from "../src/config.ts";

const token = "123456:abcdefghijklmnopqrstuvwxyz_12345678";

test("loads trimmed credentials and a numeric user ID", () => {
  assert.deepEqual(
    loadConfig({
      TELEGRAM_BOT_API_KEY: ` ${token} `,
      TELEGRAM_ALLOWED_USER_ID: " 123456789 ",
    }),
    { token, allowedUserId: 123456789 },
  );
});

test("rejects missing or malformed tokens without exposing their value", () => {
  for (const value of [
    undefined,
    "",
    " ",
    "secret-invalid-token",
    "123:short",
  ]) {
    const env: NodeJS.ProcessEnv = { TELEGRAM_ALLOWED_USER_ID: "123456789" };
    if (value !== undefined) env.TELEGRAM_BOT_API_KEY = value;
    assert.throws(() => loadConfig(env), {
      name: "Error",
      message: "Set TELEGRAM_BOT_API_KEY to a valid Telegram bot token.",
    });
  }
});

test("fails closed for missing, non-integer, negative, or unsafe user IDs", () => {
  for (const value of [
    undefined,
    "",
    "0",
    "-123",
    "1.5",
    "1e6",
    "user123",
    "9007199254740992",
  ]) {
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_API_KEY: token };
    if (value !== undefined) env.TELEGRAM_ALLOWED_USER_ID = value;
    assert.throws(() => loadConfig(env), ConfigurationError);
  }
});
