import { listCaseDocuments, listGuardianDocuments } from "@/lib/documents/store";
import type { ThreadAccessLevel, ThreadRow } from "@/lib/messaging/access";
import { PAGE_LIMIT } from "@/lib/messaging/constants";
import { attachableDocuments, listMessages, threadContext } from "@/lib/messaging/store";
import { ThreadView } from "./ThreadView";

// 027 FR-4: server part of a thread page. The caller has passed requireThreadPage(). The document picker offers
// the documents the viewer can read for the thread's child (guardian: family uploads + visible provider uploads;
// provider: the case's documents) and marks those not every participant can read (023 rules) as unavailable.
export async function ThreadPage({
  thread,
  level,
  viewerId,
  backHref,
}: {
  thread: ThreadRow;
  level: ThreadAccessLevel;
  viewerId: string;
  backHref: string;
}) {
  const family = level === "guardian";
  const [initial, context, docs] = await Promise.all([
    listMessages(thread, viewerId, { limit: PAGE_LIMIT }),
    threadContext(thread),
    family ? listGuardianDocuments([thread.child_id]) : listCaseDocuments(thread.case_id),
  ]);
  const documents = await attachableDocuments(thread.case_id, docs.map((d) => ({ id: d.id, title: d.title })));
  return (
    <ThreadView
      thread={{ id: thread.id, subject: thread.subject, archivedAt: thread.archived_at, orgName: context.orgName, childName: context.childName }}
      initial={initial}
      documents={documents}
      canArchive={level === "manage"}
      tone={family ? "family" : "provider"}
      backHref={backHref}
    />
  );
}
