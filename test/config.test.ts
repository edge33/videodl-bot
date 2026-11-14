import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  ConfigurationError,
  loadConfig,
  loadStorageConfig,
} from "../src/config.ts";

const token = "test-token";

test("loads trimmed credentials and a numeric user ID", () => {
  assert.deepEqual(
    loadConfig({
      TELEGRAM_BOT_API_KEY: ` ${token} `,
      TELEGRAM_ALLOWED_USER_ID: " 123456789 ",
    }),
    { token, allowedUserId: 123456789 },
  );
});

test("requires a non-empty token", () => {
  for (const value of [undefined, "", " "]) {
    const env: NodeJS.ProcessEnv = { TELEGRAM_ALLOWED_USER_ID: "123456789" };
    if (value !== undefined) env.TELEGRAM_BOT_API_KEY = value;
    assert.throws(() => loadConfig(env), {
      name: "Error",
      message: "Set TELEGRAM_BOT_API_KEY to your Telegram bot token.",
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

test("storage defaults and explicit absolute paths with a configurable queue limit", () => {
  const defaults = loadStorageConfig({});
  assert.equal(defaults.stateDir, resolve("state"));
  assert.equal(defaults.downloadDir, resolve("downloads"));
  assert.equal(defaults.maxPending, 20);
  assert.deepEqual(
    loadStorageConfig({
      STATE_DIR: " /tmp/state ",
      DOWNLOAD_DIR: "/tmp/downloads",
      QUEUE_MAX_PENDING: " 5 ",
    }),
    {
      stateDir: "/tmp/state",
      downloadDir: "/tmp/downloads",
      maxPending: 5,
    },
  );
  assert.deepEqual(
    loadStorageConfig({ STATE_DIR: " ", DOWNLOAD_DIR: " " }),
    defaults,
  );
});

test("storage rejects relative paths and invalid queue capacities without echoing values", () => {
  for (const env of [{ STATE_DIR: "relative" }, { DOWNLOAD_DIR: "relative" }]) {
    assert.throws(() => loadStorageConfig(env), /absolute paths/);
  }
  for (const value of ["", "0", "-1", "1.5", "1e2", "9007199254740992"]) {
    assert.throws(
      () => loadStorageConfig({ QUEUE_MAX_PENDING: value }),
      /positive safe integer/,
    );
  }
});
