import {
  PARTNER_PLATFORM_ID,
  type PlatformEntry,
} from "@/domain/platform-entry";

export interface EntryStatus {
  platform: typeof PARTNER_PLATFORM_ID;
  entry: PlatformEntry;
  status: "initialized";
}

export function getEntryStatus(entry: PlatformEntry): EntryStatus {
  return {
    platform: PARTNER_PLATFORM_ID,
    entry,
    status: "initialized",
  };
}
