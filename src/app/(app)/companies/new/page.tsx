import { ActionForm, Field } from "@/components/ActionForm";
import { PageHeader } from "@/components/ui";
import { createCompanyAction } from "@/app/actions/crm";

export default function NewCompany() {
  return (
    <div className="max-w-xl">
      <PageHeader title="Add company" />
      <div className="card">
        <ActionForm action={createCompanyAction} submitLabel="Create company">
          <Field label="Name" name="name" required />
          <Field label="Website" name="website" placeholder="https://example.co.za" />
          <Field label="Industry" name="industry" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Country (ISO code)" name="country" placeholder="ZA" />
            <Field label="City" name="city" />
          </div>
        </ActionForm>
      </div>
    </div>
  );
}
