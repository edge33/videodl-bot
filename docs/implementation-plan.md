# Container E2E in CI

Status: implemented; local verification passed, PR CI result pending.

Agreed on 2026-11-27; planned for a later request, not implemented by the
simplification PR. Add an E2E step after the existing Docker build:

- Run the bot and a local Telegram HTTP stub in separate containers on a private
  Docker network. Docker DNS lets the bot reach the stub as
  `http://telegram:8080`; the stub returns prepared updates to normal polling
  requests and records outgoing API calls.
- Expose grammY's existing `client.apiRoot` option through configuration for the
  container test. Default deployments continue using Telegram's real API.
- Derive a test image from the production image, replacing yt-dlp with a controlled
  fixture executable that emits progress and supplies a small generated media
  fixture. Keep real FFmpeg/FFprobe for conversion and validation. Exercise the
  actual container entrypoint, configuration, polling, and filesystem output.
- Use synthetic credentials and temporary download storage. Contact neither real
  Telegram nor YouTube. Use bounded waits for observable events and always remove
  test containers, networks, and storage after the run, including failures.
- Initially cover success, download failure, and cancellation. Assert one attempt,
  valid published media on success, progress edits, format-menu/status deletion,
  preservation of the user's link, a separate outcome reply, process termination
  on cancellation, and removal of attempt staging data.

Acceptance: the CI container E2E step passes the success, failure, and cancellation
scenarios above with no real service calls or credentials. Record the CI result
and keep documentation aligned with the tested behavior. Controlled CI E2E does
not establish live-service compatibility. The existing CI job now runs the harness after its Docker build.

Handoff: `test/container-e2e` adds `e2e/run.sh`, a derived test image, a
Telegram stub, and the optional `TELEGRAM_API_ROOT` setting. Review checkpoint:
verify local checks and record the PR CI result before merge.

Local verification: production Docker build, all three container scenarios,
`pnpm check`, and `pnpm test` passed (100% production coverage).
