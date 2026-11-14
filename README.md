# videodl-bot

A private Telegram bot for saving YouTube downloads to a homelab folder.

Step 1 is complete: this repository provides the development tooling and a
minimal entrypoint. Running it prints a setup message and exits. Telegram and
download behavior will be added in later steps.

## Development

Use Node.js **26.13.1** and pnpm **12.18.0**. The versions are pinned in
`.node-version` and `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm start
```

| Command          | Purpose                                               |
| ---------------- | ----------------------------------------------------- |
| `pnpm start`     | Run `src/index.ts` directly with Node                 |
| `pnpm dev`       | Run with Node's native file watcher                   |
| `pnpm typecheck` | Check types without emitting JavaScript               |
| `pnpm check`     | Check Biome formatting, lint, imports, and TypeScript |
| `pnpm format`    | Apply Biome formatting                                |

TypeScript runs through Node's native type stripping. Use ESM, explicit `.ts`
extensions for relative imports, and `import type` for type-only imports.
Use erasable syntax; enums, parameter properties, and runtime namespaces are
unsupported. Node does not read `tsconfig.json` or check types at runtime, so
run `pnpm check` before submitting changes. No compilation step is required.

## Local configuration

If you already have a `.env`, keep it. Otherwise copy `.env.example` to `.env`.
The scaffold does not load configuration or contact Telegram yet.

| Variable                   | Planned use                                          |
| -------------------------- | ---------------------------------------------------- |
| `TELEGRAM_BOT_API_KEY`     | Existing Telegram bot token; used starting in Step 2 |
| `TELEGRAM_ALLOWED_USER_ID` | Your numeric Telegram user ID for authorization      |
| `DOWNLOAD_DIR`             | Absolute host download directory for Compose         |
| `STATE_DIR`                | Absolute host SQLite state directory for Compose     |

Never commit real credentials. Local environment files, `downloads/`, `state/`,
and SQLite files are ignored by Git. CI uses no secrets or external services.

## Review checkpoints

1. Repository, pnpm, Biome, native TypeScript, and CI — current checkpoint.
2. Private Telegram connection and authorization.
3. Format buttons and persistent SQLite queue.
4. yt-dlp/FFmpeg downloads, progress, cancellation, and limits.
5. Non-root Docker Compose deployment and persistent host folders.
6. End-to-end verification.

Each step is reviewed before the next begins. The planned format choices are
MP3 at 320 kbps and MP4 capped at 720p or 1080p. Completed files stay on the
homelab; Telegram reports status and filenames.
