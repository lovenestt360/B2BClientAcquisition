import { prisma } from "@/lib/db";
import { requireRole } from "@/server/auth/current";
import { ActionForm, Field } from "@/components/ActionForm";
import { PageHeader, fmtDate } from "@/components/ui";
import { createUserAction, toggleUserAction } from "@/app/actions/users";

export default async function UsersPage() {
  const me = await requireRole("ADMIN");
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  return (
    <div className="space-y-4">
      <PageHeader title="Users & roles" subtitle="Admin: everything · Manager: approvals, compliance, audit · Operator: CRM and manual outreach · Viewer: read-only" />
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
