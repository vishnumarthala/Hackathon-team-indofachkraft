// Ticket 027: shapes of the messaging API responses. Types only, safe in client components.
import type { ProviderType } from "@/lib/providers/constants";

export type ThreadJson = {
  id: string;
  subject: string;
  case_id: string;
  org_id: string;
  child_id: string;
  created_at: string;
  last_message_at: string;
  archived_at: string | null;
};

export type ThreadListItem = ThreadJson & { org_name: string; child_name: string; case_label: string; unread: number };

export type MessageDocument = { id: string; available: true; title: string; file_name: string; mime_type: string; url: string } | { id: string; available: false };

/** One message as the viewer sees it. `sender_kind` + `discipline_label` / `provider_type` give the role label. */
export type MessageView = {
  id: string;
  thread_id: string;
  sender_id: string | null;
  sender_kind: "guardian" | "provider";
  sender_name: string | null;
  discipline_label: string | null;
  provider_type: ProviderType | null;
  body: string;
  deleted: boolean;
  created_at: string;
  own: boolean;
  can_delete: boolean;
  document: MessageDocument | null;
};
