import { prisma } from "@/lib/db";
import { requireRole } from "@/server/auth/current";
import { HOSTINGER } from "@/server/email/accounts";
import { ActionForm, Field } from "@/components/ActionForm";
import { PageHeader, fmtDate } from "@/components/ui";
import { saveAccountAction, testAccountAction, toggleAccountAction } from "@/app/actions/email";

export default async function MailboxesPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  await requireRole("ADMIN");
  const { edit } = await searchParams;
  const accounts = await prisma.emailAccount.findMany({ orderBy: { createdAt: "asc" } });
  const editing = accounts.find((a) => a.id === edit && !a.isSimulated) ?? null;
  const v = editing ?? { label: "", fromName: "", fromAddress: "", username: "", ...HOSTINGER, dailyLimit: 30 };

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Mailboxes" subtitle="Your existing Hostinger mailboxes. The password is encrypted. New mailboxes start disabled." />
      {accounts.map((a) => (
        <article key={a.id} className="card space-y-2 text-sm" data-testid="mailbox-admin">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{a.label} <span className="font-mono text-xs text-slate-500">{a.fromAddress}</span></span>
            <span className={`badge ${a.enabled ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-700"}`}>{a.enabled ? "enabled" : "disabled"}</span>
          </div>
          {a.isSimulated ? (
            <p className="text-xs text-violet-700">Simulated mailbox: emails dummy leads only and never opens a network connection.</p>
          ) : (
            <p className="text-xs text-slate-500">
              SMTP {a.smtpHost}:{a.smtpPort} ({a.smtpSecure ? "SSL/TLS" : "STARTTLS"}) · IMAP {a.imapHost}:{a.imapPort} · limit {a.dailyLimit}/day ·
              last test: {a.lastTestAt ? `${fmtDate(a.lastTestAt)}: ${a.lastTestResult}` : "never"}
            </p>
          )}
          <div className="flex flex-wrap items-start gap-2">
            {!a.isSimulated && <form action={testAccountAction}><input type="hidden" name="id" value={a.id} /><button className="btn-secondary">Test connection</button></form>}
            <ActionForm action={toggleAccountAction} submitLabel={a.enabled ? "Disable" : "Enable"} className="space-y-1">
              <input type="hidden" name="id" value={a.id} />
              <input type="hidden" name="enabled" value={a.enabled ? "false" : "true"} />
            </ActionForm>
            {!a.isSimulated && <a className="btn-secondary" href={`?edit=${a.id}`}>Edit</a>}
          </div>
        </article>
      ))}

      <section className="card">
        <h2 className="mb-2 font-semibold">{editing ? `Edit ${editing.label}` : "Add a Hostinger mailbox"}</h2>
        <ActionForm action={saveAccountAction} submitLabel="Save mailbox" key={editing?.id ?? "new"}>
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Label" name="label" required defaultValue={v.label} placeholder="Sales mailbox" />
            <Field label="Sender name" name="fromName" required defaultValue={v.fromName} placeholder="Thabo at Demo Co" />
            <Field label="Email address" name="fromAddress" type="email" required defaultValue={v.fromAddress} />
            <Field label="Username (blank = email address)" name="username" defaultValue={editing?.username ?? ""} />
          </div>
          <Field label={editing ? "Password (blank = keep current)" : "Mailbox password"} name="password" type="password" required={!editing} />
          <details>
            <summary className="cursor-pointer text-sm text-brand-700">Server settings (Hostinger defaults)</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <Field label="SMTP host" name="smtpHost" defaultValue={v.smtpHost} />
              <Field label="SMTP port" name="smtpPort" type="number" defaultValue={String(v.smtpPort)} />
              <label className="flex items-center gap-2 pt-5 text-sm"><input type="checkbox" name="smtpSecure" defaultChecked={v.smtpSecure} className="h-5 w-5" /> SSL/TLS</label>
              <Field label="IMAP host" name="imapHost" defaultValue={v.imapHost} />
              <Field label="IMAP port" name="imapPort" type="number" defaultValue={String(v.imapPort)} />
              <label className="flex items-center gap-2 pt-5 text-sm"><input type="checkbox" name="imapSecure" defaultChecked={v.imapSecure} className="h-5 w-5" /> SSL/TLS</label>
            </div>
          </details>
          <Field label="Daily send limit (start low to protect your domain's reputation)" name="dailyLimit" type="number" defaultValue={String(v.dailyLimit)} />
          <p className="text-xs text-slate-500">After saving, run <strong>Test connection</strong> (logs in to SMTP and IMAP, sends nothing), then enable.</p>
        </ActionForm>
      </section>
    </div>
  );
}
