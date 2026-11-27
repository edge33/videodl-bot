# videodl-bot implementation plan

This is the agreed implementation plan and handoff for future agents. Work in
reviewable stages; completing one stage does not authorize starting the next.
Explicit follow-up requests can refine a stage or change these decisions.

## Progress and next action

| Stage                                    | Status                        | Review                                                |
| ---------------------------------------- | ----------------------------- | ----------------------------------------------------- |
| 1. Repository and tooling                | Complete, merged              | [PR #1](https://github.com/edge33/videodl-bot/pull/1) |
| 2. Private Telegram connection           | Complete, merged              | [PR #2](https://github.com/edge33/videodl-bot/pull/2) |
| 3. Format selection and persistent queue | Complete, merged              | [PR #4](https://github.com/edge33/videodl-bot/pull/4) |
| 4. Downloads and file publication        | Merged; manual checks pending | [PR #5](https://github.com/edge33/videodl-bot/pull/5) |
| 5. Client image distribution             | Merged; manual checks pending | [PR #6](https://github.com/edge33/videodl-bot/pull/6) |
| 6. End-to-end acceptance                 | Not started                   | After Stage 5 review                                  |

Stage 4 was merged in PR #5. Stage 5 client image distribution was merged in
PR #6 (verified on 2026-11-15). Real Telegram, YouTube playback, and the previously deferred
review findings remain acceptance work. Stage 6 requires a separate request.
Update this table and the handoff notes as work progresses; use GitHub to verify
whether a PR is open or merged.

## Product decisions

- The bot serves one allowlisted Telegram user in direct chats. Ignore other
  users and group chats; authorize both messages and callback interactions.
- Accept one individual YouTube video link per message, including Shorts and
  unlisted videos. Normalize supported YouTube URLs to a video ID. A video URL
  with playlist parameters downloads only that video; playlist-only URLs fail.
- Support publicly accessible, on-demand videos. Live/scheduled streams,
  restricted or unavailable videos, and account-cookie support are outside v1.
- Offer three inline choices: **MP3 320 kbps**, **MP4 up to 720p**, and
  **MP4 up to 1080p**. The video choices select the best available resolution at
  or below the cap; a lower-resolution source is valid. Never select above 1080p.
- The first selection consumes its menu. Sending the link again offers another
  choice. Repeated taps must not create duplicate jobs.
- Save files on the homelab and report status and the final filename in Telegram.
  Completed files remain indefinitely; automatic retention and Telegram file
  uploads are outside v1.
- Build a non-root container image for client-managed deployment using long
  polling, outbound HTTPS, and persistent host storage. No Compose configuration
  is maintained in this repository; no public inbound endpoint is required.

## Foundation and configuration

The repository is [edge33/videodl-bot](https://github.com/edge33/videodl-bot).
Use Node 26 LTS with native TypeScript execution, pnpm, Biome, grammY, built-in
SQLite, yt-dlp, FFmpeg, and FFprobe. Read `.nvmrc`, `package.json`, and the lockfile
for exact runtime/tool versions; update dependencies deliberately using current
stable releases and exact pins.

Use ESM, explicit `.ts` imports, erasable syntax, and separate `tsc --noEmit`
checking. `pnpm test` uses Node's experimental coverage with 100% line, branch,
and function thresholds, including unloaded source files. The process entrypoint
is excluded; application logic remains covered. See the README for setup and
commands rather than introducing a compilation or third-party test-runner layer.

Configuration contracts:

| Variable                   | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `TELEGRAM_BOT_API_KEY`     | Required existing bot token; keep this variable name       |
| `TELEGRAM_ALLOWED_USER_ID` | Required positive, safe-integer Telegram user ID           |
| `DOWNLOAD_DIR`             | Local output path; use `/downloads` inside the container   |
| `STATE_DIR`                | Local SQLite state path; use `/state` inside the container |

Load local environment files through Node's native support and allow existing
environment variables to take precedence. Require token presence locally;
Telegram validates it during startup. The owner specifically rejected token-format
validation and its tests. Keep local credentials and the owner's actual ID in
the ignored `.env`; examples and automated tests use synthetic values.

## Stage 1 — Repository and tooling

Completed foundation:

- Initialized `main` with the GitHub remote and pinned Node/pnpm metadata.
- Added strict TypeScript, native execution/watch scripts, Biome, exact tooling
  dependencies, the pnpm lockfile, configuration examples, and ignore rules.
- Used `.nvmrc` for the runtime pin, following the owner's preference.
- Added CI on **pull requests only**, with frozen installation and project checks.

Acceptance: dependency installation, formatting/linting, type checking, native
startup, and watch startup were verified. The existing local `.env` was preserved
and ignored. Repository initialization is historical work, not a task to repeat.

## Stage 2 — Private Telegram connection

Completed behavior:

- Validate required configuration, enforce private-chat owner access, and expose
  `/start` and `/help` through grammY long polling.
- Verify the token on startup, preserve pending Telegram updates, and handle
  SIGINT/SIGTERM by cancelling polling and waiting for active handlers.
- Report configuration, connection, authentication, and polling-conflict errors
  without logging credentials or message payloads.
- Use a local HTTP Telegram stub for automated tests. Cover authorization,
  configuration, reply-error recovery, startup cancellation races, successful
  shutdown acknowledgement, and failed acknowledgement propagation.

Acceptance: frozen installation, Biome, type checking, and 13 tests passed with
100% production coverage at handoff. Live token verification, polling, graceful
shutdown, and the owner's manual Telegram test succeeded. The temporary dev
service was stopped. PR #2 is merged.

## Stage 3 — Format selection and persistent queue

- Validate and normalize individual video links, then present the agreed inline
  buttons. Persist menus so the first selection can consume one atomically.
- Add durable SQLite menus/jobs containing retry counts, job state, Telegram
  status-message references, output filenames, and terminal outcomes. Use atomic
  transactions for menu consumption and job claims.
- Process one job at a time. Deduplicate by video ID and selected format; reuse
  completed files if present, share matching pending jobs, and permit another
  download if a recorded file has been removed.
- Recover interrupted jobs on startup. Preserve queued work across restarts.
- Add `/status`, `/queue`, and `/cancel <job-id>` for queued and active jobs.
  Exercise worker behavior with a controlled downloader fixture in tests; the
  real downloader belongs to Stage 4.

Acceptance: verify valid/invalid links, owner authorization on buttons, single-use
menus, repeated taps, duplicate requests, missing completed files, queue capacity,
sequential execution, cancellation, and restart recovery. Tests remain independent
of real Telegram and YouTube services. Finish at the Stage 3 review checkpoint.

### Stage 3 handoff

Implemented URL normalization, three inline format choices, durable single-use
menus, SQLite jobs, pending/active deduplication, completed-file reuse, and
`/status [job-id]`, `/queue`, and `/cancel <job-id>`. Menu consumption and job
creation share a transaction; claims use one atomic statement with database
indexes enforcing one active job and one pending job per video/format.

`STATE_DIR` and `DOWNLOAD_DIR` now configure local storage, defaulting to resolved
`./state` and `./downloads`. `QUEUE_MAX_PENDING` defaults to 20. A full queue leaves
the menu available for retry. Interrupted active work returns to the queue on
startup; terminal outcomes remain intact. A restart can temporarily leave 21
pending jobs when the active slot is recovered; new jobs wait for capacity.

The production entrypoint persists requests but deliberately has no downloader
connected yet. `QueueWorker` is exercised with controlled fixtures, including
sequential execution, failures, aborting active work through `/cancel`, and
shutdown/restart recovery. Stage 4 must connect the worker to the entrypoint,
start/wake it as work arrives, pass it to the Telegram handlers for active
cancellation, and await it before closing SQLite. It also adds real retries,
artifact validation/publication, progress, and notification retries.

Validation: `pnpm check` and 36 automated tests pass with 100% production line,
branch, and function coverage. Tests use temporary SQLite files and a loopback
Telegram API stub; no real Telegram or YouTube service was contacted. Real
Telegram manual verification of Stage 3 remains a review activity. No dependency
or lockfile changes were needed.

## Stage 4 — Downloads and file publication

- Invoke yt-dlp/FFmpeg through subprocess argument arrays, with fixed format
  policies, ambient yt-dlp configuration disabled, and playlist downloads disabled.
  Include yt-dlp's required YouTube JavaScript runtime/challenge support.
- Inspect metadata before downloading and enforce source/access/duration policy.
  Prefer H.264/AAC MP4 through merging or remuxing without video re-encoding;
  report failure when compatible output is unavailable. Encode MP3 at 320 kbps
  without suggesting this improves source fidelity.
- Stage each job below the download mount. Validate its final artifact and
  atomically publish it into the flat output folder without overwriting files.
  Use sanitized, bounded title,
  YouTube ID, and selected format in filenames. Prevent accidental overwrites.
- Retry transient network/download failures at most twice, with 10- and 30-second
  backoff. Report permanent failures immediately. Recover interrupted work and
  resume partial downloads where supported.
- Terminate downloader process groups, including FFmpeg children, on cancellation,
  timeout, or shutdown. Retain resumable work for interrupted jobs and remove
  temporary files after terminal failure/cancellation.
- Reconcile a published file after a crash between rename and database update so
  recovery does not download it again unnecessarily.
- Edit one status message per job at most every 10 seconds: queue position,
  download percentage when available, processing, and final result. Report the
  filename on success. Retain job outcomes for `/status`; retry transient Telegram
  notification failures without repeating a download.

Configurable resource defaults:

| Limit                                  | Default                            |
| -------------------------------------- | ---------------------------------- |
| Source duration                        | 2 hours                            |
| Final file size                        | 4 GiB                              |
| Free-space reserve                     | 2 GiB                              |
| Active job deadline, including retries | 60 minutes                         |
| Pending jobs                           | 20, with one additional active job |

Check metadata/disk space before work, monitor free space during processing, and
validate the final file size before publication. yt-dlp's own size option does not
guarantee final artifact size or temporary disk usage; merging/conversion can use
more disk than the final output.

Acceptance: test all three choices, lower-resolution fallback, permanent/transient
failures, retries, cancellation, process cleanup, restart reconciliation, and all
resource protections, including oversized converted output. Use controlled
subprocess fixtures for routine tests and an authorized video for manual playback
checks. Finish at the Stage 4 review checkpoint.

### Stage 4 handoff

Connected the worker to production, including startup recovery, continuous queue
processing, active cancellation, and shutdown before SQLite closes. Added fixed
yt-dlp argument policies, Node JavaScript runtime selection with locally installed
EJS support, metadata/access checks, FFprobe validation, resource protections,
two durable retries, and process-group termination. No dependency versions or
lockfile changed. Local `.env` is preserved.

Publication deliberately uses an atomic hard link followed by staging removal,
rather than a rename that can overwrite existing files. SQLite records the intended
filename before publication so recovery reconciles the file even if staging was
already removed. The filesystem must support same-mount hard links. Progress,
queue positions, processing, and terminal results edit the stored status message;
notification attempts are durable and independent of download retries.

Resource defaults are configurable through `MAX_DURATION_SECONDS`, `MAX_FILE_BYTES`,
`FREE_SPACE_RESERVE_BYTES`, and `JOB_DEADLINE_MS`. The active deadline includes
backoff and downtime across restarts; the initial active start time and retry counts
are durable. Resource defaults and their type now share one declaration in
`src/download-limits.ts`, used by environment loading and downloader construction.
Disk monitoring samples once a second and cannot guarantee against
short-lived temporary-space spikes. README documents tool setup and operations.

Review follow-up: recovered/retried MP3 jobs discard staged `media.mp3` before
invoking yt-dlp, because interrupted FFmpeg conversion can leave readable but
truncated output that yt-dlp would otherwise reuse. Source audio and partial
downloads remain available for resumption. Published-file reconciliation is
unchanged. Regression tests cover shutdown/recovery and transient retries.
Cancellation cleanup now removes queued-job staging immediately and waits for
active downloader exit before final cleanup. Startup retries removal of retained
staging for failed/cancelled jobs. Cleanup failures preserve terminal state and
produce a safe warning. Published output and resumable queued work are preserved.
Disk checks now share one in-flight request across timer ticks and publication,
and the duplicate initial free-space check was removed. This closes the
monitoring concurrency finding. Queue polling has been replaced by startup/new-job wake-ups. The scheduler drains
work until idle and remembers wake-ups received while draining. Events fire after
SQLite insertion and before Telegram I/O. Status delivery has its own 10-second
timer. Scheduling, failure propagation, and shutdown waits are extracted into
`src/service.ts` and tested, closing the orchestration finding. Probe validation
remains open. The latest review also found that Telegram failures before status
reference persistence can suppress automatic job notifications, and some premature
connection closures are classified as permanent rather than retried. The owner
explicitly deferred the notification change for now; these findings remain open
for review. `/status` retains durable job results.

Validation: `pnpm check` and 101 tests via `pnpm test` pass with 100% production
line, branch, and function coverage. `git diff --check` passes. Automated
verification uses the local Telegram API stub, controlled subprocesses, and downloader fixtures. Manual authorized-video playback, real Telegram progress,
and real-tool YouTube challenge compatibility remain review checks. No real token
or YouTube request was used. Stage 5 must provision pinned media tools and EJS in
the image; implementation is recorded below.

## Stage 5 — Client image distribution

- Provide an image that executes TypeScript on pinned Node 26 with pinned
  yt-dlp/EJS, FFmpeg, and FFprobe. Publication is deferred.
- Create `/downloads` and `/state` in the Dockerfile and run non-root. Clients
  provide persistent host mounts and runtime UID/GID; check writable paths on startup.
- Document image consumption, permissions, backups, recovery, and upgrades.
  Client deployment orchestration lives outside this repository.

Acceptance: build/start the image, confirm file permissions, verify persistent
files/jobs across recreation. Finish at the Stage 5 review checkpoint.

### Stage 5 handoff

The owner changed scope after the initial Compose draft: remove Compose from this
repository and build an image for clients instead; publication was deferred at that checkpoint. Existing host bind mounts
remain the storage choice. The Dockerfile creates and owns internal `/downloads`
and `/state`; host mounts hide those directories and require matching ownership.
A non-root entrypoint validates storage. Runtime `--user UID:GID` supports client
ownership without rebuilding, with cache data written below `/tmp`.

The image pins Node 26.13.1 by digest, pnpm 12.18.0, yt-dlp 2026.10.26 with verified
amd64/arm64 hashes and bundled EJS, FFmpeg/FFprobe 5.1.9, and CA certificates.
Other OS packages resolve from Debian repositories at build time. The build-context
allowlist excludes credentials, media, state, and Git. Application dependencies and
local `.env` are unchanged. README now documents client `docker run` consumption,
backups and upgrades. GHCR (`ghcr.io/edge33/videodl-bot`) remains the selected
registry for future publication, but the owner explicitly requested build-only
for now. PR validation is consolidated in `.github/workflows/ci.yml`: TypeScript,
lint (Biome formatting/imports included), tests, and Docker build. The separate
image workflow and CI runtime smoke step were removed at the owner's request.
Permissions remain read-only, with no registry login, package-write permission,
or main/tag publishing triggers. No image has been published.

Validation of the initial image: `pnpm check`, 101 tests with 100% production
coverage, amd64 build, offline tool/storage checks, and recreated-container
persistence/ownership checks passed. Custom UID/GID 1001/1001 image checks passed.
The revised image also passed runtime UID/GID 1001/1001 storage/cache checks
without rebuilding; `pnpm check`, all 101 tests with 100% production coverage,
and containerized `actionlint` validation of both workflows pass after the revision.
Negative checks rejected root, read-only storage, missing credentials, and missing
host bind paths. Initial Compose-only validation is historical; Compose has since
been removed. Arm64 and real client/Telegram/YouTube checks remain outstanding.
No real bot instance was started or real Telegram/YouTube requests made.

### Dependency maintenance follow-up

The owner requested a full dependency refresh and Renovate automation. Verified
stable releases on 2026-11-15: application/tooling packages, Node 26.13.1, the
Node image digest, yt-dlp 2026.10.26, Debian media tools, and GitHub Actions were
already current. Updated pnpm from 12.18.0 to 12.21.0 in package metadata,
Dockerfile, and lockfile. Added explicit pins for downloader-stage curl and CA
certificates. Historical handoff versions above record the original validation.

Renovate covers npm and transitive lockfile maintenance, Node runtime/types,
pnpm, Biome/schema, GitHub Actions, Docker images/syntax/digests, yt-dlp releases
and both architecture checksums, and Bookworm packages via Repology’s `debian_12`
repository (including security and updates). Native Debian lookups require gzip
indexes, which Bookworm security does not publish, so they were replaced after
the read-only lookup dry run exposed missing security package versions. Matching Node, pnpm, and Biome pins are grouped; no automerge.
The yt-dlp asset version and digest travel together per architecture. The hosted
Renovate GitHub App must be enabled for the repository and the configuration
merged before automated PRs can run. No later acceptance stage is started.

Validation: frozen pnpm installation, `pnpm check`, and all 101 tests passed
with 100% production line/branch/function coverage. Strict Renovate configuration
validation passed; local read-only extraction detected runtime, package, schema,
workflow, image, and both yt-dlp checksum dependencies. Read-only lookup resolved
all Debian pins through Repology. GitHub-backed lookups require the hosted app’s
credentials; local lookup also encountered Docker Hub tag-listing rate/access
limits. The existing Node digest was independently verified with `docker pull`.
The amd64 image build and offline non-root/tool/storage smoke checks passed.
Arm64 execution and real Telegram/YouTube acceptance remain outstanding.

### Release automation follow-up

The owner authorized Release Please and GHCR publication after release PR merge
and tag creation. This supersedes the earlier build-only restriction; routine PR
CI remains read-only and does not publish. Dependency PR #7 was verified merged
on 2026-11-15 before starting `feat/release-ghcr` from updated `main`.

`release.yml` manages root Node releases on `main` with a manifest baseline of
0.1.0 and bootstrap commit `5845f1112064702fc0c386c7b25271b285675749`. Release PRs
update the package version, changelog, and manifest. Conventional commits drive
version selection; while pre-1.0, features/fixes bump patch and breaking changes
bump minor. Merging the release PR creates a stable `vX.Y.Z` tag and GitHub release.
Only a newly created release invokes the reusable publisher. It checks out the
exact tag, requires a published stable release on `main` with matching package
version, runs project checks, and builds/pushes amd64 and arm64 images to
`ghcr.io/edge33/videodl-bot:X.Y.Z`. Only the current latest stable release updates
`:latest`. A manual dispatch accepts an existing release tag to retry a failed
publication; it creates no new version.

Release Please uses a repository-scoped `RELEASE_PLEASE_TOKEN` so its generated
PRs trigger CI. The publisher uses automatic `GITHUB_TOKEN` authentication with
job-scoped package write permission. No secrets existed when setup was inspected;
the owner must configure the release token and ensure Actions PR creation policy
permits the automation. Check GHCR visibility after first publication for client
pull access. No release PR has been merged, tag created, or image published during
implementation. Real Telegram/YouTube and Stage 6 acceptance remain separate work.

Validation: `pnpm check` and all 101 tests pass with 100% production line, branch,
and function coverage. All three workflows pass actionlint 1.7.12, including shell
checks. Release Please configuration passes its official JSON schema. Nine local
fixture checks execute the publisher’s actual validation shell: stable release,
lowercase registry naming, older-release retry, invalid/prerelease/missing tags,
version mismatch, draft/prerelease release metadata, unrelated history, and tag/HEAD
mismatch. The amd64 Docker build and `git diff --check` pass. Live Release Please,
GHCR publication, and the multi-platform build await repository credentials and
merging the automation/release PRs; no publishing test was run.

## Stage 6 — End-to-end acceptance

- Run Biome, type checking, native tests/coverage, frozen installation, and
  container checks appropriate to the final implementation.
- Verify the real Telegram workflow, each output format, playback, progress,
  cancellation, duplicate reuse, and restart recovery.
- Review changes for scope, readability, credentials, and unintended generated or
  lockfile changes. Complete configuration and operating documentation.

Acceptance: report actual results, the worktree/branch and PR, plus remaining
limitations or manual checks. Mark the plan complete only when all required
behavior and acceptance work are finished.
