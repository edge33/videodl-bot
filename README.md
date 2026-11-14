# videodl-bot

A private Telegram bot for saving YouTube downloads to a homelab folder.

Step 2 provides a private Telegram connection with `/start` and `/help`.
Only the configured user can interact with the bot in a direct chat. Other users
and group chats are ignored. Downloads and format selection will follow in Step 3
and Step 4.

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

| Variable                   | Planned use                                      |
| -------------------------- | ------------------------------------------------ |
| `TELEGRAM_BOT_API_KEY`     | Required Telegram bot token                      |
| `TELEGRAM_ALLOWED_USER_ID` | Your numeric Telegram user ID for authorization  |
| `DOWNLOAD_DIR`             | Absolute host download directory for Compose     |
| `STATE_DIR`                | Absolute host SQLite state directory for Compose |

Never commit real credentials. Local environment files, `downloads/`, `state/`,
and SQLite files are ignored by Git. CI uses no secrets or external services.

Once startup reports that polling has begun, open the bot's direct chat in
Telegram and send `/start` or `/help`. Stop it with Ctrl+C or SIGTERM. Shutdown
cancels polling and waits for active handlers. Run only one instance per bot
token; long polling needs outbound HTTPS access, with no public endpoint.

The bot currently accepts message and callback updates, but exposes only the
two commands above. It keeps pending Telegram updates on startup. Application
errors are reported without logging tokens or message payloads. Tests use
synthetic credentials and a loopback HTTP server; they never load `.env`.

## Implementation plan

See [docs/implementation-plan.md](docs/implementation-plan.md) for the agreed
behavior, six stages, current progress, and acceptance criteria. Agent workflow
and project conventions are in [AGENTS.md](AGENTS.md).
