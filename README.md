# videodl-bot

A private Telegram bot for saving YouTube downloads to a homelab folder.

Send a YouTube link, choose MP3 or MP4, and receive the saved filename in
Telegram. The bot downloads and converts once. If the attempt fails, it removes
temporary files and reports the failure. Only the configured user can interact
with the bot in a private chat.

## Development

Use the exact Node.js and pnpm versions pinned in `.nvmrc` and `package.json`.
With nvm installed, run `nvm install` and `nvm use`.

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
| `pnpm lint`      | Check Biome formatting, lint, and imports             |
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
signals and the environment to tested application functions. Download sessions,
cancellation, and Telegram replies are tested separately. Test fixtures and dependencies are outside the source inclusion pattern. PR CI runs
the same coverage-enforcing command.

## Local configuration

If you already have a `.env`, keep it. Otherwise copy `.env.example` to `.env`.
Set `TELEGRAM_BOT_API_KEY` and `TELEGRAM_ALLOWED_USER_ID`, then run `pnpm start`
(or `pnpm dev` while developing). Both commands load `.env` using Node's native
environment-file support; existing environment variables take precedence.
The token must be present and the allowed user ID must be a positive integer.
Telegram validates the token during the startup connection check; no local token
format rules are applied. Configuration errors do not include credential values.

| Variable                   | Use                                                      |
| -------------------------- | -------------------------------------------------------- |
| `TELEGRAM_BOT_API_KEY`     | Required Telegram bot token                              |
| `TELEGRAM_ALLOWED_USER_ID` | Your numeric Telegram user ID for authorization          |
| `DOWNLOAD_DIR`             | Absolute output path; defaults to `./downloads` resolved |

An empty output path defaults to `./downloads`, resolved from the current working
directory. An explicit path must be absolute. Startup creates the output folder.
`STATE_DIR` and `QUEUE_MAX_PENDING` are no longer used; existing SQLite files are
left untouched and can be removed manually after stopping the old deployment.

Never commit real credentials. Local environment files, `downloads/`, `state/`,
and SQLite files are ignored by Git. CI uses no secrets or external services.

Once startup reports that polling has begun, open the bot's direct chat in
Telegram and send `/start` or `/help`. Stop it with Ctrl+C or SIGTERM. Shutdown
cancels polling and waits for active handlers. Run only one instance per bot
token; long polling needs outbound HTTPS access, with no public endpoint.

The bot keeps pending Telegram updates on startup. Application errors are
reported without logging tokens or message payloads. Tests use synthetic
credentials and a loopback HTTP server; they never load `.env`.

## Download flow

Send one complete YouTube video URL per message: `youtube.com/watch?v=...`,
`youtu.be/...`, or `youtube.com/shorts/...`. Playlist-only URLs and multiple links
are rejected. A watch URL with playlist parameters selects only that video.
Only public/unlisted, on-demand sources within the duration limit are accepted.

Choose **MP3 320 kbps**, **MP4 up to 720p**, or **MP4 up to 1080p**. A selection
deletes its format menu. Sending another link replaces an unused menu. Only one download
runs at a time; additional requests receive a busy reply and must be sent again
later. Every accepted request downloads a new file, including repeated videos.

- `/start` and `/help` show readiness and available commands.
- `/cancel` aborts the active download and conversion.

Telegram receives one temporary status message: `Download and converting`, then
download percentage updates at most once every 10 seconds when yt-dlp reports
progress. When the attempt ends, the bot deletes the status, keeps the user’s original link message, and sends a new
outcome message (`Done: filename`, failure, or cancellation). Progress-edit or
status-deletion failures are safely logged without preventing the outcome reply.
There is no queue, job history, automatic retry, file reuse, resume, restart
recovery, or notification retry scheduler. Graceful shutdown terminates media
processes and removes temporary files. A forced process/host termination can leave
staging files; they are never resumed and may be removed manually when stopped.

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

Files stage in `DOWNLOAD_DIR/.staging/<unique-id>`. FFprobe validates duration,
container, codecs, and resolution, and the bot checks final size before publishing
to the flat output directory. Names contain a sanitized bounded title, video ID,
format, and unique ID. An atomic hard link prevents overwrites; the output
filesystem must support hard links. Temporary files are removed after success,
failure, cancellation, or graceful shutdown.

| Variable                   | Default    | Purpose                             |
| -------------------------- | ---------- | ----------------------------------- |
| `MAX_DURATION_SECONDS`     | 7200       | Maximum source and final duration   |
| `MAX_FILE_BYTES`           | 4294967296 | Maximum final artifact size (4 GiB) |
| `FREE_SPACE_RESERVE_BYTES` | 2147483648 | Required free space (2 GiB)         |
| `JOB_DEADLINE_MS`          | 3600000    | Maximum duration of one attempt     |

All overrides must be positive safe integers. Disk space is checked before work,
after processing, and every second while tools run. Checks share any in-flight
filesystem request, so slow storage cannot accumulate overlapping checks. Temporary conversion/merge
usage may exceed the final size; sampling cannot prevent a sudden disk-space
spike between checks. Failed downloads are not retried. Media tools run with
bounded output and safe JSON diagnostics are written to stdout.

## Container image

This repository provides a Dockerfile, build-only PR checks, and release image
publication to `ghcr.io/edge33/videodl-bot`. Deployment orchestration belongs to
clients. No Compose file is maintained here.

The Dockerfile pins Node by digest, pnpm, yt-dlp (with bundled EJS and
architecture-specific SHA-256 checks), and Debian FFmpeg/FFprobe, CA certificates,
and curl. See the Dockerfile for exact versions. It runs TypeScript directly as a non-root
user. Supported image architectures are amd64 and arm64; only amd64 has been exercised locally.

The Dockerfile creates `/downloads`, owned by UID/GID 1000/1000.
Clients can supply `--user UID:GID` to match their host storage owner. Writable
cache data goes below `/tmp`, allowing arbitrary non-root runtime IDs without
rebuilding. Bind mounts hide the image directories: existing host paths must
have matching ownership. The startup entrypoint rejects root execution and
inaccessible storage; application startup validates configuration.

Keep credentials in a local environment file. The following example uses the
existing `.env`, sets the internal output path, and mounts an existing host folder. After the first successful release, pull a
published version (replace `X.Y.Z` with that release version). Use Docker's
`--mount` form so missing host folders fail instead of being silently created
with root ownership.

```sh
IMAGE=ghcr.io/edge33/videodl-bot:X.Y.Z
docker pull "$IMAGE"
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0750 /srv/videodl/downloads
docker run -d --name videodl-bot --init --restart unless-stopped --stop-timeout 60 \
  --user "$(id -u):$(id -g)" \
  --env-file .env --env DOWNLOAD_DIR=/downloads \
  --mount type=bind,source=/srv/videodl/downloads,target=/downloads \
  "$IMAGE"
docker logs --tail=50 videodl-bot
docker stop videodl-bot
```

The image needs outbound HTTPS/DNS and no published ports. Completed files use
the runtime UID/GID. Run only one instance per token;
stop local polling before starting a container. Each client supplies its own token,
allowed user ID, and storage. Never put credentials into an image or build argument.
The allowlist `.dockerignore` excludes `.env`, media, SQLite state, and Git data.

Recreation preserves completed files in the download bind mount. To back up,
stop the container and copy that directory. To upgrade, pull the new version,
stop/remove the old container, and recreate it against the same download mount.
Removing a container does not remove its host bind mount. A state mount is no
longer required.

`.github/workflows/ci.yml` runs on pull requests only, with four validation steps:
TypeScript (`tsc --noEmit`), lint/format/import checks, tests with coverage, and
Docker image build. PR CI has no runtime smoke step or registry credentials.
Release publication runs separately after a release PR merges, as described below.

`APP_UID`/`APP_GID` remain optional Docker build arguments for custom images;
clients can use `--user` without rebuilding. Rebuild the image after merging
dependency updates; transitive OS packages resolve at build time.

Offline smoke checks cover storage, permissions, and media tools. Real
Telegram polling, YouTube downloads, and playback remain manual acceptance.

## Releases and GHCR

[Release Please](https://github.com/googleapis/release-please-action) runs on
pushes to `main`, maintaining a release PR with `package.json` version changes,
`CHANGELOG.md`, and `.release-please-manifest.json`. Squash merge PRs with
Conventional Commit titles: `fix:` for fixes, `feat:` for features, and `!` or
`BREAKING CHANGE:` for incompatible changes. The initial manifest uses the existing
`0.1.0` version as its baseline; bootstrap history begins after dependency PR #7.
Before `1.0.0`, features and fixes bump patch versions, while breaking changes
bump minor versions. Review and merge the generated release PR to approve a release.

Once that PR is merged, Release Please creates the `vX.Y.Z` tag and GitHub release.
The same workflow then calls the image publisher, which checks out the exact tag,
verifies it belongs to `main` and matches `package.json`, and repeats project checks
before building and pushing `linux/amd64` and `linux/arm64` images. Publication
runs only when a release is created. Ordinary PRs and main pushes do not publish.
This explicit workflow call also avoids relying on a tag event to start another
workflow. Do not create or push tags manually for the normal release process.

Images use `ghcr.io/edge33/videodl-bot:X.Y.Z`. The `latest` alias is updated only
when publishing GitHub’s current latest stable release; clients should prefer an
exact version or digest for controlled upgrades. OCI labels identify the source,
version, and tagged commit. The publish job alone has `packages: write` and logs
in with the repository’s automatic `GITHUB_TOKEN`; no registry password is needed.

One-time repository setup:

1. Add an Actions secret named `RELEASE_PLEASE_TOKEN`: a fine-grained personal
   access token restricted to this repository with **Contents**, **Pull requests**,
   and **Issues** read/write permissions. A dedicated bot account is suitable.
   Keep it outside source control and rotate it before expiry. A personal token
   is used so release PR creation and updates trigger normal PR CI; the default
   `GITHUB_TOKEN` suppresses those workflow events. See the
   [Release Please credential requirements](https://github.com/googleapis/release-please-action#github-credentials).
2. Ensure repository/organization Actions policy permits the release action to
   create PRs and releases. If required by policy, enable “Allow GitHub Actions to
   create and approve pull requests” in Settings → Actions → General.
3. After the first publish, check the GHCR package visibility/access settings.
   New packages default to private; make the package public for anonymous client
   pulls, or give clients authenticated read access. See
   [GitHub’s container registry permissions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

The workflow reports a clear error if the release token has not been configured.
Merge the automation PR, wait for its Release run, review the generated release PR,
and merge it after CI passes. The resulting Release run publishes the image.
No npm package is published (`package.json` remains private).

If tagging succeeds but the image publish fails, use Actions → **Publish image** →
**Run workflow** on `main` and supply the existing `vX.Y.Z` tag. This rebuilds that
release without creating another version. It rejects missing, draft, prerelease,
unrelated, and version-mismatched releases. Retrying an older release preserves
`latest`. Never move an existing release tag. For local builds before the first
publication, use `docker build -t videodl-bot:local .` and that local image name.

## Dependency updates

[`renovate.json`](renovate.json) configures reviewed update PRs for npm packages,
transitive lockfile maintenance, Node (`.nvmrc`, package engines, Docker base image,
and types), pnpm (package metadata and Dockerfile), Biome and its schema, GitHub
Actions, Docker images/digests and Dockerfile syntax, yt-dlp releases with both
architecture checksums, and pinned Debian packages. EJS ships with yt-dlp;
FFprobe ships with FFmpeg. Debian lookups use Repology’s `debian_12` repository,
including Bookworm updates and security packages; a distribution migration needs
matching lookup changes. Renovate’s native Debian datasource currently requires
gzip indexes, which Bookworm security does not publish.
Node, pnpm, and Biome updates are grouped to keep their pins together. Stable
major updates are offered for review; automerge is disabled.

Enable the [Mend Renovate GitHub App](https://github.com/apps/renovate) for this
repository and merge this configuration into the default branch to activate it.
The repository configuration alone does not install or authorize the app. No bot
token or scheduled workflow is required when using the hosted app. Update PRs run
the existing CI checks. The Dependency Dashboard tracks pending updates.

The Dockerfile custom managers follow the [Renovate custom manager presets](https://docs.renovatebot.com/presets-customManagers/);
Debian lookups follow the [Repology datasource documentation](https://docs.renovatebot.com/modules/datasource/repology/).

## Implementation plan

See [docs/implementation-plan.md](docs/implementation-plan.md) for the deferred
container E2E work in CI and its acceptance criteria. Agent workflow
and project conventions are in [AGENTS.md](AGENTS.md).
