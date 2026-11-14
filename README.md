# videodl-bot

A private Telegram bot for saving YouTube downloads to a homelab folder.

Stage 4 connects the persistent queue to yt-dlp and FFmpeg. Only the configured
user can interact with the bot in a direct chat; other users and group chats are
ignored. Downloads are saved locally, with progress and final filenames reported
in Telegram. Docker deployment belongs to Stage 5.

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
together. One job runs at a time; additional jobs wait in the durable queue.

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
Only public/unlisted, on-demand sources within the duration limit are accepted.

Choose **MP3 320 kbps**, **MP4 up to 720p**, or **MP4 up to 1080p**. The first
accepted selection consumes the menu. Send the link again for another format.
Repeated selections of the same video and format share queued/active work or
reuse a completed file when it still exists. A removed output permits a new job.
When the queue is full, the menu stays usable so you can retry after cancelling
work or after work finishes.

- `/start` and `/help` show readiness and available commands.
- `/status` shows the ten most recent jobs, including terminal outcomes.
- `/status <job-id>` shows one job and its recorded filename/outcome.
- `/queue` lists active and queued jobs in processing order.
- `/cancel <job-id>` cancels a queued or active job. Cancellation is final;
  send the link again to request another job.

Menus, jobs, status-message references, retry counts, and terminal results are
persistent. Startup requeues interrupted active jobs while preserving completed,
failed, and cancelled history. The single worker cancels its whole media process
group on owner cancellation,
shutdown, or deadline. Shutdown retains partial downloads for restart; terminal
failures and cancellation remove staging files.

## Download tools and policies

Install `yt-dlp`, `ffmpeg`, and `ffprobe` on `PATH` before running downloads.
yt-dlp must include its matching `yt-dlp-ejs` package (included in official
executables; Python installs can use the `default` extra). The bot explicitly
selects the pinned Node executable as the YouTube JavaScript runtime, disables
ambient yt-dlp configuration and remote component fetching, and never loads
account cookies. See the [official EJS setup guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS).
Pinned image/tool provisioning is part of Stage 5; no tools are installed by the bot.
On Arch/CachyOS, install the required tools with:

```sh
sudo pacman -S --needed yt-dlp yt-dlp-ejs ffmpeg
```

The FFmpeg package supplies `ffprobe` as well. Automated `pnpm test` runs require
no media tools installed; they use fixtures.

MP4 selects H.264 video and AAC audio at or below 720p/1080p, allowing lower
resolutions, then merges/remuxes without video re-encoding. Incompatible sources
fail rather than exceeding the selected cap. MP3 encodes at 320 kbps; this does
not improve the fidelity of the source.

Files stage in `DOWNLOAD_DIR/.staging/<job-id>`. FFprobe validates duration,
container, codecs, and resolution, and the bot checks final size before publishing
to the flat output directory. Names contain a sanitized bounded title, video ID,
format, and job ID. Publication uses an atomic hard link on the same filesystem
to prevent overwrites, then removes staging. The intended filename is persisted
in SQLite first so restart can reconcile an already published file. The output
filesystem must support hard links; keep both the state and download directories.

| Variable                   | Default    | Purpose                                         |
| -------------------------- | ---------- | ----------------------------------------------- |
| `MAX_DURATION_SECONDS`     | 7200       | Maximum source and final duration               |
| `MAX_FILE_BYTES`           | 4294967296 | Maximum final artifact size (4 GiB)             |
| `FREE_SPACE_RESERVE_BYTES` | 2147483648 | Required free space (2 GiB)                     |
| `JOB_DEADLINE_MS`          | 3600000    | Active deadline, including retries and restarts |

All overrides must be positive safe integers. Disk space is checked before work,
after processing, and every second while tools run. Temporary conversion/merge
usage may exceed the final size; sampling cannot prevent a sudden disk-space
spike between checks. The initial active start time and retry count persist across restarts. Transient network/download failures get at most two
retries, after 10 and 30 seconds; permanent failures stop immediately.

Status edits are limited to one per job every 10 seconds. Delivery state and
attempt times survive restart; transient Telegram errors retry independently of
downloads. Deleted/uneditable status messages stop retrying the unchanged status;
`/status` retains the result. Progress percentages appear when yt-dlp supplies
them. Automated tests use controlled executable tools and the local Telegram
stub, without real tokens or YouTube requests. Live playback checks remain part
of the Stage 4 review checkpoint.

## Implementation plan

See [docs/implementation-plan.md](docs/implementation-plan.md) for the agreed
behavior, six stages, current progress, and acceptance criteria. Agent workflow
and project conventions are in [AGENTS.md](AGENTS.md).
