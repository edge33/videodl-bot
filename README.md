# videodl-bot

A private Telegram bot for saving YouTube downloads to a homelab folder.

Stage 3 adds format selection and a persistent SQLite queue. Only the configured
user can interact with the bot in a direct chat; other users and group chats are
ignored. Requests are saved across restarts. Actual downloads arrive in Stage 4;
this stage leaves requests queued and exercises the worker with test fixtures.

## Development

Use Node.js **26.13.1** and pnpm **12.18.0**. The versions are pinned in
`.nvmrc` and `package.json`. With nvm installed, run `nvm install` and `nvm use`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

| Command          | Purpose                                               |
| ---------------- | ----------------------------------------------------- |
| `pnpm start`     | Run `src/index.ts` directly with Node                 |
| `pnpm dev`       | Run with Node's native file watcher                   |
| `pnpm test`      | Run native Node tests with enforced 100% coverage     |
| `pnpm typecheck` | Check types without emitting JavaScript               |
| `pnpm check`     | Check Biome formatting, lint, imports, and TypeScript |
| `pnpm format`    | Apply Biome formatting                                |

TypeScript runs through Node's native type stripping. Use ESM, explicit `.ts`
extensions for relative imports, and `import type` for type-only imports.
Use erasable syntax; enums, parameter properties, and runtime namespaces are
unsupported. Node does not read `tsconfig.json` or check types at runtime, so
run `pnpm check` before submitting changes. No compilation step is required.

`pnpm test` uses Node's `--experimental-test-coverage` and requires 100% line,
branch, and function coverage. Coverage includes all `src/**/*.ts` files, even
those not imported by a test. Only `src/index.ts` is excluded: it wires process
signals and the environment to the tested bot/configuration functions. Test
fixtures and dependencies are outside the source inclusion pattern. PR CI runs
the same coverage-enforcing command.

## Local configuration

If you already have a `.env`, keep it. Otherwise copy `.env.example` to `.env`.
Set `TELEGRAM_BOT_API_KEY` and `TELEGRAM_ALLOWED_USER_ID`, then run `pnpm start`
(or `pnpm dev` while developing). Both commands load `.env` using Node's native
environment-file support; existing environment variables take precedence.
The token must be present and the allowed user ID must be a positive integer.
Telegram validates the token during the startup connection check; no local token
format rules are applied. Configuration errors do not include credential values.

| Variable                   | Use                                                         |
| -------------------------- | ----------------------------------------------------------- |
| `TELEGRAM_BOT_API_KEY`     | Required Telegram bot token                                 |
| `TELEGRAM_ALLOWED_USER_ID` | Your numeric Telegram user ID for authorization             |
| `DOWNLOAD_DIR`             | Absolute output path; defaults to `./downloads` resolved    |
| `STATE_DIR`                | Absolute state path; defaults to `./state` resolved         |
| `QUEUE_MAX_PENDING`        | Positive pending-job limit; defaults to 20, plus one active |

Empty directory settings use the defaults relative to the current working
directory. Explicit paths must be absolute. Startup creates both directories;
state is stored in `STATE_DIR/queue.sqlite`. Keep the database and its WAL files
together. With no downloader connected, all Stage 3 jobs count as pending.

Never commit real credentials. Local environment files, `downloads/`, `state/`,
and SQLite files are ignored by Git. CI uses no secrets or external services.

Once startup reports that polling has begun, open the bot's direct chat in
Telegram and send `/start` or `/help`. Stop it with Ctrl+C or SIGTERM. Shutdown
cancels polling and waits for active handlers. Run only one instance per bot
token; long polling needs outbound HTTPS access, with no public endpoint.

The bot keeps pending Telegram updates on startup. Application errors are
reported without logging tokens or message payloads. Tests use synthetic
credentials and a loopback HTTP server; they never load `.env`.

## Format selection and queue

Send one complete YouTube video URL per message: `youtube.com/watch?v=...`,
`youtu.be/...`, or `youtube.com/shorts/...`. Playlist-only URLs and multiple links
are rejected. A watch URL with playlist parameters selects only that video.
Source availability and live/restricted-video checks belong to Stage 4.

Choose **MP3 320 kbps**, **MP4 up to 720p**, or **MP4 up to 1080p**. The first
accepted selection consumes the menu. Send the link again for another format.
Repeated selections of the same video and format share queued/active work or
reuse a completed file when it still exists. A removed output permits a new job.
When the queue is full, the menu stays usable so you can retry after cancelling
work or, from Stage 4, after work finishes.

- `/start` and `/help` show readiness and available commands.
- `/status` shows the ten most recent jobs, including terminal outcomes.
- `/status <job-id>` shows one job and its recorded filename/outcome.
- `/queue` lists active and queued jobs in processing order.
- `/cancel <job-id>` cancels a queued or active job. Cancellation is final;
  send the link again to request another job.

Menus, jobs, status-message references, retry counts, and terminal results are
persistent. Startup requeues interrupted active jobs while preserving completed,
failed, and cancelled history. The single-worker boundary supports cancellation
and graceful interruption; tests inject a controlled downloader. Stage 4 will
connect the real downloader and status updates to the running bot. No downloads
or media subprocesses run in Stage 3.

## Implementation plan

See [docs/implementation-plan.md](docs/implementation-plan.md) for the agreed
behavior, six stages, current progress, and acceptance criteria. Agent workflow
and project conventions are in [AGENTS.md](AGENTS.md).
