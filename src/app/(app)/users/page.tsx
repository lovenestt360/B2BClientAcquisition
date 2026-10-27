import { prisma } from "@/lib/db";
import { requireRole } from "@/server/auth/current";
import { ActionForm, Field } from "@/components/ActionForm";
import { PageHeader, fmtDate } from "@/components/ui";
import { changeOwnEmailAction, changeOwnPasswordAction, createUserAction, toggleUserAction } from "@/app/actions/users";

export default async function UsersPage() {
  const me = await requireRole("ADMIN");
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  return (
    <div className="space-y-4">
      <PageHeader title="Users & roles" subtitle="Admin: everything · Manager: approvals, compliance, audit · Operator: CRM and manual outreach · Viewer: read-only" />
      <section aria-labelledby="account-security-title">
        <div className="mb-3">
          <h2 id="account-security-title" className="font-semibold">Your administrator account</h2>
          <p className="text-sm text-slate-600">Update the credentials you use to sign in. Both changes require your current password.</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card">
            <h3 className="mb-1 font-semibold">Change email</h3>
            <p className="mb-3 text-sm text-slate-600">Your new email becomes your sign-in address immediately.</p>
            <ActionForm action={changeOwnEmailAction} submitLabel="Update Email">
              <Field label="New email" name="email" type="email" required defaultValue={me.email} autoComplete="email" />
              <Field label="Current password" name="currentPassword" type="password" required autoComplete="current-password" />
            </ActionForm>
          </div>
          <div className="card">
            <h3 className="mb-1 font-semibold">Change password</h3>
            <p className="mb-3 text-sm text-slate-600">For security, changing it signs you out on every device.</p>
            <ActionForm action={changeOwnPasswordAction} submitLabel="Update Password">
              <Field label="Current password" name="currentPassword" type="password" required autoComplete="current-password" />
              <Field label="New password (min 10 chars)" name="newPassword" type="password" required autoComplete="new-password" />
              <Field label="Confirm new password" name="confirmPassword" type="password" required autoComplete="new-password" />
            </ActionForm>
          </div>
        </div>
      </section>
      <div className="card overflow-x-auto p-0">
        <table className="tbl">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th className="hidden sm:table-cell">Last login</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? "" : "opacity-50"}>
                <td>{u.name}</td><td>{u.email}</td><td>{u.role.toLowerCase()}</td>
                <td className="hidden sm:table-cell">{fmtDate(u.lastLoginAt)}</td>
                <td>{u.id !== me.id && <form action={toggleUserAction}><input type="hidden" name="userId" value={u.id} /><button className="text-xs text-brand-700 hover:underline">{u.active ? "Deactivate" : "Activate"}</button></form>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card max-w-xl">
        <h2 className="mb-2 font-semibold">Add user</h2>
        <ActionForm action={createUserAction} submitLabel="Create user">
          <Field label="Name" name="name" required />
          <Field label="Email" name="email" type="email" required />
          <Field label="Temporary password (min 10 chars)" name="password" type="password" required />
          <div>
            <label className="label" htmlFor="role">Role</label>
            <select className="input" id="role" name="role" defaultValue="OPERATOR">
              <option>VIEWER</option><option>OPERATOR</option><option>MANAGER</option><option>ADMIN</option>
            </select>
          </div>
        </ActionForm>
      </div>
    </div>
  );
}
