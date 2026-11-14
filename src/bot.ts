import { AbortController as RequestAbortController } from "abort-controller";
import {
  Bot,
  type BotConfig,
  type Context,
  GrammyError,
  HttpError,
} from "grammy";
import { type Config, ConfigurationError } from "./config.ts";
import { type QueueServices, registerQueueHandlers } from "./queue-handlers.ts";

export function describeError(error: unknown): string {
  if (error instanceof ConfigurationError) return error.message;
  if (error instanceof GrammyError) {
    if (error.error_code === 401) return "Telegram rejected the bot token.";
    if (error.error_code === 409) {
      return "Telegram polling conflicts with another bot instance. Run only one instance.";
    }
    return `Telegram API request failed (code ${error.error_code}).`;
  }
  if (error instanceof HttpError) {
    return "Cannot reach Telegram. Check the network connection.";
  }
  return "Unexpected bot error. Check configuration and restart the service.";
}

export function createBot(
  config: Config,
  options: BotConfig<Context> = {},
  queue?: QueueServices,
): Bot {
  const bot = new Bot(config.token, {
    ...options,
    client: { timeoutSeconds: 45, ...options.client, sensitiveLogs: false },
  });

  bot.use(async (ctx, next) => {
    if (
      ctx.chat?.type !== "private" ||
      ctx.from?.is_bot ||
      ctx.from?.id !== config.allowedUserId
    ) {
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome to videodl-bot. Your private Telegram connection is ready.\n" +
        "Use /help for available commands.",
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "/start — Check that the bot is ready\n" +
        "/help — Show this help\n\n" +
        "/status [job-id] — Show recent jobs or one job\n" +
        "/queue — Show queued and active jobs\n" +
        "/cancel <job-id> — Cancel a job\n\n" +
        "Send one YouTube video link to choose a format. Requests are saved; downloads are not enabled yet.",
    );
  });

  if (queue) registerQueueHandlers(bot, queue);

  // Raw Telegram errors can contain request payloads or credential-bearing URLs.
  bot.catch((error) => {
    console.error(
      "Could not handle Telegram update:",
      describeError(error.error),
    );
  });

  return bot;
}

export async function runBot(bot: Bot, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;

  // grammY's Node transport expects its polyfill signal, not Node's native type.
  const request = new RequestAbortController();
  let stopping: Promise<void> | undefined;
  const stop = () => {
    request.abort();
    if (!bot.isRunning()) return;
    console.info("Stopping Telegram polling.");
    stopping = bot.stop();
    // Observe immediately; propagate failures after polling and handlers finish.
    void stopping.catch(() => {});
  };

  signal.addEventListener("abort", stop, { once: true });
  try {
    // One bounded connection check avoids retrying an invalid startup forever.
    bot.botInfo = await bot.api.getMe(request.signal);
    if (signal.aborted) return;

    await bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: () =>
        console.info("Telegram bot is polling for private messages."),
    });
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    await stopping;
  }
}
