import { prisma } from "@/lib/db";
import { ActionForm, Field } from "@/components/ActionForm";
import { PageHeader } from "@/components/ui";
import { createContactAction } from "@/app/actions/crm";

export default async function NewContact() {
  const companies = await prisma.company.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true }, take: 500 });
  return (
    <div className="max-w-xl">
      <PageHeader title="Add contact" subtitle="Only enter details you obtained lawfully and can source." />
      <div className="card">
        <ActionForm action={createContactAction} submitLabel="Create contact">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name" name="firstName" required />
            <Field label="Last name" name="lastName" />
          </div>
          <Field label="Email" name="email" type="email" />
          <Field label="Phone" name="phone" type="tel" placeholder="+27 82 123 4567" />
          <Field label="Title" name="title" />
          <div>
            <label className="label" htmlFor="companyId">Company</label>
            <select className="input" id="companyId" name="companyId" defaultValue="">
              <option value="">— none —</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <Field label="Country (ISO code)" name="country" placeholder="ZA" />
          <div>
            <label className="label" htmlFor="notes">Notes</label>
            <textarea className="input" id="notes" name="notes" rows={3} />
          </div>
        </ActionForm>
      </div>
    </div>
  );
}
