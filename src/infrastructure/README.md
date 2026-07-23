# Infrastructure layer

Adapter database, network, logging, and external services owned by Partner Platform belong here. This layer must not import source code or Prisma Client from Main Platform.

## Persistence (`database/`)

The raw Prisma client is constructed only in `database/client.ts` and is never
exposed to routes, components, or handlers — the task 1.3 import-boundary lint
rules forbid the transport layer from importing `@infrastructure/**` or the
generated Prisma client at all. Application services reach persistence through:

- `TenantContext` (`tenant-context.ts`) — a validated, frozen `partnerId` taken
  from the trusted session/service principal. Every tenant-scoped repository
  method requires one.
- Tenant-scoped repositories (`partner-*-repository.ts`, base
  `tenant-repository.ts`) — fold `partnerId` into every predicate for
  defense-in-depth isolation. Cross-tenant ids resolve to `RESOURCE_NOT_FOUND`.
- Compare-and-set / versioning (`tenant-scoping.ts`) — optimistic concurrency on
  the aggregate `version`; a stale version raises a retryable
  `ConcurrencyConflictError`.
- Unit of work (`unit-of-work.ts`) — runs atomic, multi-write work inside a
  single transaction bound to a `TenantContext`; use `runInTenantTransaction`
  to get repositories pre-bound to the transaction.

Errors carry a `kind` field so the transport boundary's `mapDomainError`
produces the stable safe error envelope without extra glue.
