/**
 * Admin audit browser service (task 15.4, requirements 16.7, 19.1, 19.2).
 *
 * A thin, read-only façade over {@link AuditBrowserReadGateway} that bounds the
 * paging parameters (so a caller can never request an unbounded page) and
 * normalises an optional action/partner filter. Any authenticated admin may
 * browse the audit trail; it exposes only redaction-safe rows, so there is no
 * additional permission gate here — the sensitive capability (revealing raw
 * SMS) lives in its own gated service.
 */
import { AUDIT_ACTIONS, type AuditAction } from "@domain/task-5-7";

import type {
  AuditBrowserReadGateway,
  AuditEventPage,
} from "./audit-browser-ports";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AUDIT_ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export interface AdminAuditListInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly action?: string;
  readonly partnerId?: string;
}

export interface AdminAuditServiceDeps {
  readonly gateway: AuditBrowserReadGateway;
}

export class AdminAuditService {
  private readonly deps: AdminAuditServiceDeps;

  constructor(deps: AdminAuditServiceDeps) {
    this.deps = deps;
  }

  /** List a bounded, redaction-safe page of audit events, newest first. */
  listAuditEvents(input: AdminAuditListInput = {}): Promise<AuditEventPage> {
    const page = boundPage(input.page);
    const pageSize = boundPageSize(input.pageSize);
    const action = normalizeAction(input.action);
    const partnerId =
      input.partnerId && UUID_PATTERN.test(input.partnerId) ? input.partnerId : undefined;

    return this.deps.gateway.listAuditEvents({ page, pageSize, action, partnerId });
  }
}

function boundPage(page: number | undefined): number {
  if (!Number.isFinite(page) || page === undefined || page < 1) return 1;
  return Math.floor(page);
}

function boundPageSize(pageSize: number | undefined): number {
  if (!Number.isFinite(pageSize) || pageSize === undefined || pageSize < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(pageSize), MAX_PAGE_SIZE);
}

function normalizeAction(action: string | undefined): AuditAction | undefined {
  if (action && AUDIT_ACTION_SET.has(action)) return action as AuditAction;
  return undefined;
}
