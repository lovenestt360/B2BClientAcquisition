import Link from "next/link";
import { prisma } from "@/lib/db";
import { getAvailability, slotLabel } from "@/server/sales/availability";
import { Empty, PageHeader, fmtDate } from "@/components/ui";

const STATUS: Record<string, string> = {
  tentative: "bg-amber-100 text-amber-900",
  scheduled: "bg-green-100 text-green-800",
  needs_reschedule: "bg-red-100 text-red-800",
  simulated: "bg-violet-100 text-violet-800",
  cancelled: "bg-slate-200 text-slate-600",
  completed: "bg-slate-100 text-slate-700",
};

export default async function MeetingsPage() {
  const { timeZone } = await getAvailability(prisma);
  const meetings = await prisma.meeting.findMany({
    where: { startsAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    include: { contact: { select: { id: true, firstName: true, lastName: true, company: { select: { name: true } } } } },
    orderBy: { startsAt: "asc" },
    take: 100,
  });
  return (
    <div className="space-y-4">
      <PageHeader title="Meetings" subtitle="Booked by the AI caller or by you. Simulated = rehearsal bookings from the sandbox." />
      {meetings.length === 0 ? <Empty>No meetings yet.</Empty> : (
        <ul className="space-y-2">
          {meetings.map((m) => (
            <li key={m.id} className="card flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="meeting">
              <div>
                <p className="font-medium">{slotLabel(m.startsAt, timeZone)}</p>
                <p>
                  <Link className="text-brand-700" href={`/contacts/${m.contact.id}`}>{m.contact.firstName} {m.contact.lastName}</Link>
                  {m.contact.company && <span className="text-slate-500"> · {m.contact.company.name}</span>}
                </p>
                <p className="text-xs text-slate-500">{m.title} · {Math.round((m.endsAt.getTime() - m.startsAt.getTime()) / 60000)} min · booked {fmtDate(m.createdAt)}</p>
                {m.notes && <p className="text-xs text-slate-500">{m.notes}</p>}
              </div>
              <div className="flex items-center gap-2">
                <span className={`badge ${STATUS[m.status] ?? "bg-slate-100"}`}>{m.status.replace("_", " ")}</span>
                {m.callId && <Link className="text-xs text-brand-700" href={`/calls/${m.callId}`}>call transcript</Link>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
