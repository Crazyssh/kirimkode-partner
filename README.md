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

API and cron routes are reserved boundaries and intentionally return `501` until their application services are implemented.

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
