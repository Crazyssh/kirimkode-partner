# KirimKode Partner Platform

Standalone Next.js application for Partner Portal, Partner Admin, Internal API v1, Agent API v1, and cron jobs.

## Isolation

This package owns its dependencies, lockfile, runtime, and build/cache directories. It does not import Main Platform source code or its Prisma Client. Cross-platform integration must use the versioned Internal API.

- Package: `@kirimkode/partner-platform`
- Development/production port: `3001`
- Build output: `.partner-next`
- Tool cache: `.partner-cache`

## Entry points

- Partner portal: `/`
- Partner admin: `/admin`
- Internal API v1: `/api/internal/v1`
- Agent API v1: `/api/agent/v1`
- Cron v1: `POST /api/cron/v1`

Any route whose application service is not implemented yet returns `501`; the surfaces listed above are implemented.

## Operating the background jobs

Seven jobs carry the platform's money and hygiene: `offline-sweep`,
`reservation-recovery`, `order-timeout`, `order-completion-sweep`,
`earning-release`, `retention-redaction`, `reconcile`. They only run when
something dispatches them, and **if nothing does, the failure is silent**:
earnings never become available (so partners can never cash out), held numbers
are never released, and expired orders are never refunded.

Register exactly **one** minutely scheduler entry:

```bash
node scripts/run-cron.mjs        # dispatches whatever is due at this minute
```

Per-job cadence lives in `scripts/lib/cron-schedule.mjs`, so it is version
controlled and code reviewed rather than spread across an operator's crontab.
`src/test/partner-cron-schedule.unit.test.ts` fails if a registered job has no
schedule entry, so a new job cannot silently go unscheduled.

Required environment: `PARTNER_CRON_SECRET` (the bearer the dispatch route
verifies). `PARTNER_CRON_BASE_URL` defaults to `http://127.0.0.1:3001`.

```bash
node scripts/run-cron.mjs --dry-run        # print the plan, call nothing
node scripts/run-cron.mjs --job=reconcile  # dispatch one job now
node scripts/run-cron.mjs --all            # dispatch every job (manual catch-up)
```

The script exits non-zero when any dispatched job fails, so a scheduler that
reports failures will surface it. One job failing never stops the others.
Copy-paste crontab / systemd-timer / Task Scheduler snippets are at the bottom
of `scripts/run-cron.mjs`.

## Local commands

```bash
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm run test:property
npm run test:integration
npm run build
```

## CI and migration safety

`.github/workflows/partner-ci.yml` runs the pinned Partner toolchain only: migration SQL scanning, lint, typecheck, unit/property/integration tests, build, and migrations against an empty disposable PostgreSQL database. It does not invoke a parent-directory package, a Main Platform migration, or any process restart.

Partner database ownership is limited to `prisma/schema.prisma` and `prisma/migrations` in this repository. During MVP, run:

```bash
npm run migration:check
PARTNER_MIGRATION_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/kirimkode_partner_ci npm run migration:from-empty
```

The scanner rejects executable `DROP` and `TRUNCATE` tokens, including `ALTER TABLE ... DROP COLUMN`. The empty-database command accepts only disposable database names beginning with `kirimkode_partner_ci`; it refuses the production Partner database and Main database names. If the Partner Prisma schema has not been introduced yet, the command still verifies repository ownership, SQL safety, and that the disposable target is empty.
