/**
 * Public API of the member-management application module. Transport imports the
 * service and its input/outcome types from here; adapters stay internal.
 */
export { getMemberServices, type MemberServices } from "./get-member-services";
export {
  MemberManagementService,
  type InviteMemberInput,
  type UpdateMemberInput,
  type RevokeMemberInput,
  type MemberCommandOutcome,
} from "./member-management-service";
export type {
  MemberRole,
  MemberStatus,
  MemberView,
} from "./ports";
