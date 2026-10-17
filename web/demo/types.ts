/**
 * The demo service's shapes (demo/stub-api.mjs): what an app's own types file looks like. Accounts are keyed by uuid
 * and shown by their current id; a share names an exact account.
 */
import type { AccountKind } from "@/lib/format";

export type ItemStatus = "draft" | "active" | "done";

export interface AccountRef {
  uuid: string;
  id: string;
  kind: AccountKind;
  display_name?: string | null;
  pfp_url?: string | null;
}

export interface ItemEvent {
  at: string;
  action: string;
  /** The current id of who did it. */
  by: string | null;
}

export interface Item {
  id: string;
  title: string;
  description: string;
  status: ItemStatus;
  owner: AccountRef;
  /** "owner" for your own items, "shared" for items others shared with you. */
  role: "owner" | "shared";
  shares: AccountRef[];
  created_at: string;
  updated_at: string;
  history: ItemEvent[];
}

export interface Settings {
  notify_on_share: boolean;
  weekly_summary: boolean;
  show_ids: boolean;
  default_shares: AccountRef[];
}

export const STATUS_LABELS: Record<ItemStatus, string> = { draft: "Draft", active: "Active", done: "Done" };
export const STATUS_TONES: Record<ItemStatus, "neutral" | "info" | "success"> = { draft: "neutral", active: "info", done: "success" };
