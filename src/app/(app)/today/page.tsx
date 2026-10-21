import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { getHalt } from "@/server/compliance/controls";
import { now } from "@/server/clock";
import { localTime, rulesFor } from "@/server/compliance/rules";
import { startOfLocalDay, todayActivity, workQueueCounts } from "@/server/today";
import { Empty, Stat } from "@/components/ui";
import { SmsReadyCard } from "@/components/outreach/SmsReadyCard";
import { CallCard } from "@/components/outreach/CallCard";
import { EmailReadyCard } from "@/components/outreach/EmailReadyCard";

/**
 * Phone-first work queue: everything that needs a thumb on the iPhone, in order.
 * 1) finish what you started (confirm sends, record call outcomes) 2) send approved SMS 3) make calls.
 */
export default async function TodayPage() {
  const user = await requireUser();
  const t = now();
  const [halt, counts, activity, providers] = await Promise.all([
    getHalt(prisma),
    workQueueCounts(prisma),
    todayActivity(prisma, startOfLocalDay(t)),
    prisma.providerConfig.findMany({ where: { kind: "SMS" }, select: { key: true, mode: true } }),
  ]);
  const drafts = await prisma.messageDraft.findMany({
    where: { channel: "SMS", status: { in: ["APPROVED", "HANDED_OFF"] } },
    include: { contact: { select: { id: true, firstName: true, lastName: true, isSimulated: true } } },
    orderBy: [{ status: "desc" }, { approvedAt: "asc" }], // HANDED_OFF (awaiting confirmation) first
    take: 25,
  });
  const calls = await prisma.call.findMany({
    where: { mode: "MANUAL", status: { in: ["QUEUED", "DIALING"] } },
    include: { contact: { include: { company: true, phoneNumbers: true } } },
    orderBy: [{ status: "desc" }, { createdAt: "asc" }], // DIALING (awaiting outcome) before QUEUED
    take: 25,
  });
  const emails = await prisma.messageDraft.findMany({
    where: { channel: "EMAIL", status: "APPROVED" },
    include: { contact: { select: { firstName: true, lastName: true } }, emailAccount: { select: { isSimulated: true } } },
    orderBy: { approvedAt: "asc" },
    take: 25,
  });
  const windowNote = rulesFor("ZA").contactWindow!(localTime(t, process.env.APP_TIMEZONE ?? "Africa/Johannesburg"));
  const mode = (key: string) => providers.find((p) => p.key === key)?.mode ?? "MANUAL";
  const empty = drafts.length === 0 && calls.length === 0 && emails.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h1 className="h1">Today</h1>
          <p className="muted">{t.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", timeZone: process.env.APP_TIMEZONE ?? "Africa/Johannesburg" })}</p>
        </div>
        {can(user.role, "outreach.approve") && counts.awaitingApproval > 0 && (
          <Link href="/sms" className="btn-secondary">{counts.awaitingApproval} to approve</Link>
        )}
      </div>

      {halt.halted && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">Emergency stop is active. Outreach is paused.</p>}
      {windowNote && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="contact-window">
          Outside South African contact hours ({windowNote.replace(/^CPA Reg 4: /, "")}). Sending and dialling will be blocked until the window opens.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="today-stats">
        <Stat label="SMS + email sent" value={activity.smsConfirmed + activity.emailsSent} />
        <Stat label="Replies" value={activity.replies} />
        <Stat label="Calls made" value={activity.callsDone} />
        <Stat label="Meetings" value={activity.meetings} />
      </div>

      {counts.inboxOpen > 0 && (
        <Link href="/inbox" className="card flex items-center justify-between text-sm" data-testid="today-inbox">
          <span>📥 {counts.inboxOpen} {counts.inboxOpen === 1 ? "reply needs" : "replies need"} your attention</span>
          <span className="text-brand-700">Open inbox →</span>
        </Link>
      )}

      {empty && (
        <Empty>
          Nothing waiting. {can(user.role, "outreach.draft") && <><Link className="text-brand-700 underline" href="/sms">Draft SMS</Link> or <Link className="text-brand-700 underline" href="/calls">queue calls</Link>.</>}
        </Empty>
      )}

      {drafts.length > 0 && (
        <section className="space-y-2" aria-labelledby="t-sms">
          <h2 id="t-sms" className="font-semibold">
            💬 Messages to send ({drafts.length})
            {counts.awaitingConfirmation > 0 && <span className="ml-2 text-xs font-normal text-amber-700">{counts.awaitingConfirmation} waiting for your confirmation</span>}
          </h2>
          {drafts.map((d) => <SmsReadyCard key={d.id} draft={d} mode={mode(d.providerKey)} />)}
        </section>
      )}

      {emails.length > 0 && (
        <section className="space-y-2" aria-labelledby="t-email">
          <h2 id="t-email" className="font-semibold">✉️ Emails to send ({emails.length})</h2>
          {emails.map((d) => <EmailReadyCard key={d.id} draft={d} />)}
        </section>
      )}

      {calls.length > 0 && (
        <section className="space-y-2" aria-labelledby="t-calls">
          <h2 id="t-calls" className="font-semibold">
            📞 Calls ({calls.length})
            {counts.callsAwaitingOutcome > 0 && <span className="ml-2 text-xs font-normal text-amber-700">{counts.callsAwaitingOutcome} need an outcome</span>}
          </h2>
          {calls.map((c) => <CallCard key={c.id} call={c} />)}
        </section>
      )}
    </div>
  );
}
