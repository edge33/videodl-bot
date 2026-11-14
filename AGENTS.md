# Working on videodl-bot

## Start here

- Before implementing or resuming a feature, read
  [docs/implementation-plan.md](docs/implementation-plan.md) for agreed behavior,
  stage status, and acceptance criteria. Use [README.md](README.md) for setup.
- Work on the requested stage and finish at its review checkpoint. Start later
  stages when the user requests them. Explicit user instructions define scope.
- For a new stage, sync `main` and create a focused branch. Put review follow-ups
  on the existing PR branch while that PR is open.
- Update the plan's progress and handoff notes when a stage is completed or an
  agreed decision changes. Verify PR/merge status before recording it.

## Implementation conventions

- Use the Node version in `.nvmrc`, pnpm version in `package.json`, and existing
  lockfile. Execute TypeScript natively with Node; type-check without emitting.
- Use ESM, explicit `.ts` relative imports, `import type`, and erasable TypeScript
  syntax. Biome owns formatting, linting, and import organization.
- Prefer small cohesive functions, explicit control flow, and early returns.
  Reuse current tools and patterns; introduce helpers for meaningful shared work.
- Keep Telegram handlers, durable job operations, and downloader execution
  separate as those capabilities are added. Validate external input at boundaries.
- Keep changes focused. Pin new dependencies to exact stable versions with pnpm;
  preserve existing dependency versions unless an update is in scope.

## Credentials and external services

- Preserve the local `.env`. Use `.env.example` to document configuration and
  synthetic credentials in tests. Keep tokens and message payloads out of logs,
  commits, PRs, and test output.
- Require a non-empty token locally; delegate token validity to Telegram's
  startup connection check. Enforce the configured user ID and private-chat
  restriction before handling commands or callbacks.
- Use the local Telegram API stub for automated tests. Real-token checks belong
  to explicitly requested integration work. Run only one polling instance per
  token, and stop temporary test services when finished unless asked to leave them running.

## Verification and delivery

- Run `pnpm check` and `pnpm test` before handing off code changes. Tests require
  loopback networking. For documentation-only changes, run `pnpm check` and
  verify links and recorded project state.
- Keep native Node coverage at 100% for production lines, branches, and functions.
  Cover observable behavior and failure cases. Document exclusions for process
  wiring or other files without meaningful application logic; keep authorization,
  configuration, queue, and downloader logic covered.
- Give each test one clear purpose. Share transport setup and fixtures; keep
  success and failure scenarios in separately named tests rather than boolean modes.
- Review the diff for scope, credentials, and unintended generated or lockfile
  changes. Update setup/configuration documentation when behavior changes.
- Finish with the result, worktree and branch, checks actually run, PR link when
  applicable, and any blockers or manual verification still needed.
