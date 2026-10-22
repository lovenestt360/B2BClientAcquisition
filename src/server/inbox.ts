import type { Db } from "@/lib/db";
import { audit } from "./audit";
import { stripQuoted } from "./email/parse";

export interface InboxItem {
  kind: "email" | "sms";
  id: string;
  contact: { id: string; firstName: string; lastName: string | null } | null;
  from: string;
  subject: string | null;
  preview: string;
  label: string | null; // classification
  evidence: string; // how we know about it
  occurredAt: Date;
  handled: boolean;
  threadHref: string;
}

/** Inbound email (synced from IMAP) and SMS replies (entered by hand), newest first. */
export async function listInbox(db: Db, opts: { status?: "open" | "all"; label?: string; take?: number } = {}): Promise<InboxItem[]> {
  const take = opts.take ?? 50;
  const open = opts.status !== "all";
  const [emails, sms] = await Promise.all([
    db.emailMessage.findMany({
      where: { direction: "inbound", ...(open ? { handledAt: null } : {}), ...(opts.label ? { classification: opts.label } : {}) },
      include: { contact: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { occurredAt: "desc" },
      take,
    }),
    opts.label && opts.label !== "sms"
      ? []
      : db.smsEvent.findMany({
          where: { direction: "inbound", ...(open ? { handledAt: null } : {}) },
          include: { contact: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { occurredAt: "desc" },
          take,
        }),
  ]);
  const items: InboxItem[] = [
    ...emails.map((e) => ({
      kind: "email" as const,
      id: e.id,
      contact: e.contact,
      from: e.fromAddress,
      subject: e.subject,
      preview: (stripQuoted(e.bodyText) || e.bodyText).replace(/\s+/g, " ").slice(0, 160),
      label: e.classification,
      evidence: "synced from mailbox",
      occurredAt: e.occurredAt,
      handled: !!e.handledAt,
      threadHref: e.contactId ? `/email/${e.contactId}` : `/inbox/email/${e.id}`,
    })),
    ...sms.map((s) => ({
      kind: "sms" as const,
      id: s.id,
      contact: s.contact,
      from: "SMS",
      subject: null,
      preview: (s.body ?? "").slice(0, 160),
      label: null,
      evidence: s.evidence === "user_attestation" ? "entered by you" : "provider",
      occurredAt: s.occurredAt,
      handled: !!s.handledAt,
      threadHref: `/sms/${s.contactId}`,
    })),
  ];
  return items.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, take);
}

export async function openInboxCount(db: Db) {
  const [e, s] = await Promise.all([
    db.emailMessage.count({ where: { direction: "inbound", handledAt: null } }),
    db.smsEvent.count({ where: { direction: "inbound", handledAt: null } }),
  ]);
  return e + s;
}

export async function setHandled(db: Db, kind: "email" | "sms", id: string, handled: boolean, actorId: string) {
  const handledAt = handled ? new Date() : null;
  if (kind === "email") await db.emailMessage.update({ where: { id }, data: { handledAt } });
  else await db.smsEvent.update({ where: { id }, data: { handledAt } });
  await audit(db, { actorId, action: handled ? "inbox.done" : "inbox.reopen", entityType: kind === "email" ? "email_message" : "sms_event", entityId: id });
}
