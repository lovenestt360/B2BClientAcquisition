import { prisma } from "@/lib/db";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { getPlaybook, playbookReady } from "@/server/sales/playbook";
import { busyMeetings, freeSlots, getAvailability, pickTwo, slotLabel } from "@/server/sales/availability";
import { now } from "@/server/clock";
import { ActionForm, Field } from "@/components/ActionForm";
import { PageHeader } from "@/components/ui";
import { saveAvailabilityAction, savePlaybookAction } from "@/app/actions/sales";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function PlaybookPage() {
  const user = await requireUser();
  const edit = can(user.role, "outreach.approve");
  const [p, a] = await Promise.all([getPlaybook(prisma), getAvailability(prisma)]);
  const t = now();
  const slots = freeSlots(t, a, await busyMeetings(prisma, t), 40);
  const sample = pickTwo(slots, a.timeZone);
  const missing = playbookReady(p);

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Sales playbook" subtitle="What the AI caller sells, how, and when it can book you. It only uses what you write here." />
      {!edit && <p className="text-sm text-slate-500">Only managers and admins can change the playbook.</p>}
      {missing.length > 0 && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="alert">Before the AI can call a lead: {missing.join(", ")}.</p>}

      <section className="card">
        <h2 className="mb-2 font-semibold">Offer &amp; pitch</h2>
        <ActionForm action={savePlaybookAction} submitLabel="Save playbook">
          <Field label="Your name (the AI says it's calling for you, in your voice)" name="ownerName" defaultValue={p.ownerName} placeholder="Mario" />
          <div>
            <label className="label" htmlFor="offer">What you sell (one paragraph)</label>
            <textarea className="input" id="offer" name="offer" rows={3} defaultValue={p.offer} placeholder="We help logistics companies automate dispatch and delivery admin…" />
          </div>
          <div>
            <label className="label" htmlFor="idealCustomer">Ideal customer</label>
            <input className="input" id="idealCustomer" name="idealCustomer" defaultValue={p.idealCustomer} placeholder="SA logistics firms with 10–200 vehicles" />
          </div>
          <div>
            <label className="label" htmlFor="valueProps">Value points (one per line; the pitch is built from these)</label>
            <textarea className="input" id="valueProps" name="valueProps" rows={4} defaultValue={p.valueProps.join("\n")} placeholder={"Cut dispatch admin in half\nFewer delivery-note errors"} />
          </div>
          <div>
            <label className="label" htmlFor="proofPoints">Proof points (true results only, one per line)</label>
            <textarea className="input" id="proofPoints" name="proofPoints" rows={3} defaultValue={p.proofPoints.join("\n")} placeholder="A Gauteng courier saved 12 hours a week" />
          </div>
          <Field label="What the AI may say about price" name="pricingGuidance" defaultValue={p.pricingGuidance} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Meeting length (min)" name="meetingLengthMin" type="number" defaultValue={String(p.meetingLengthMin)} />
            <Field label="Meeting format" name="meetingFormat" defaultValue={p.meetingFormat} placeholder="video call" />
          </div>
        </ActionForm>
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">When the AI can book you</h2>
        <ActionForm action={saveAvailabilityAction} submitLabel="Save availability">
          <fieldset className="flex flex-wrap gap-3 text-sm">
            <legend className="label">Days</legend>
            {DAYS.map((d, i) => (
              <label key={d} className="flex items-center gap-1"><input type="checkbox" name="days" value={i} defaultChecked={a.days.includes(i)} className="h-5 w-5" /> {d}</label>
            ))}
          </fieldset>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Field label="From (hour)" name="startHour" type="number" defaultValue={String(a.startHour)} />
            <Field label="Until (hour)" name="endHour" type="number" defaultValue={String(a.endHour)} />
            <Field label="Slot length (min)" name="slotMinutes" type="number" defaultValue={String(a.slotMinutes)} />
            <Field label="Buffer between meetings (min)" name="bufferMinutes" type="number" defaultValue={String(a.bufferMinutes)} />
            <Field label="Minimum notice (hours)" name="minNoticeHours" type="number" defaultValue={String(a.minNoticeHours)} />
            <Field label="Book up to (days ahead)" name="horizonDays" type="number" defaultValue={String(a.horizonDays)} />
          </div>
          <input type="hidden" name="timeZone" value={a.timeZone} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="skipPublicHolidays" defaultChecked={a.skipPublicHolidays} className="h-5 w-5" /> Skip South African public holidays</label>
        </ActionForm>
        <p className="text-sm text-slate-600" data-testid="sample-slots">
          {sample.length ? (
            <>
              Right now the AI would offer:{" "}
              {sample.map((d, i) => (
                <span key={d.toISOString()}>{i > 0 && " or "}<strong>{slotLabel(d, a.timeZone)}</strong></span>
              ))}
              . {slots.length} free slots in the window.
            </>
          ) : (
            "No free slots in the window."
          )}
        </p>
        <p className="text-xs text-slate-500">Google Calendar sync comes next; until then, AI-booked meetings are marked tentative and listed under Meetings.</p>
      </section>
    </div>
  );
}
