"use client";

// Admin User Management — real Supabase Auth + app_users. Admin can create city
// managers (with an initial password), reassign their warehouse / role,
// activate-deactivate, and delete. Admin-only (middleware gates /users).

import { useMemo, useState } from "react";
import { CITIES, type City } from "@/lib/sample-data";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { errText, useToast } from "@/components/toast";
import {
  useUsers,
  createUser,
  updateUser,
  deleteUser,
  type ManagedUser,
} from "@/lib/hooks/use-users";

type FormRole = "admin" | "manager";

interface FormState {
  id: string | null; // null = create, set = edit
  name: string;
  email: string;
  password: string;
  role: FormRole;
  city: City;
  status: "active" | "inactive";
}

const EMPTY: FormState = {
  id: null, name: "", email: "", password: "", role: "manager", city: "DELHI", status: "active",
};

export default function UsersPage() {
  const { users, loading, error, refetch } = useUsers();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      users.filter(
        (u) =>
          search === "" ||
          u.name.toLowerCase().includes(search.toLowerCase()) ||
          u.email.toLowerCase().includes(search.toLowerCase())
      ),
    [users, search]
  );
  const active = users.filter((u) => u.status === "active").length;

  function openCreate() {
    setForm(EMPTY);
    setFormError(null);
    setPanelOpen(true);
  }
  function openEdit(u: ManagedUser) {
    setForm({
      id: u.id, name: u.name, email: u.email, password: "",
      role: u.role === "admin" ? "admin" : "manager",
      city: (u.city ?? "DELHI") as City, status: u.status,
    });
    setFormError(null);
    setPanelOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      if (form.id === null) {
        await createUser({
          email: form.email, name: form.name, role: form.role,
          city: form.role === "manager" ? form.city : null, password: form.password,
        });
      } else {
        await updateUser(form.id, {
          name: form.name, role: form.role,
          city: form.role === "manager" ? form.city : null, status: form.status,
        });
      }
      setPanelOpen(false);
      refetch();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(u: ManagedUser) {
    const next = u.status === "active" ? "inactive" : "active";
    try {
      await updateUser(u.id, { status: next });
      toast.success(
        next === "active" ? `${u.name} can sign in again.` : `${u.name} can no longer sign in.`
      );
      refetch();
    } catch (err) {
      toast.error(`Could not update ${u.name}.`, { detail: errText(err) });
    }
  }
  async function handleDelete(u: ManagedUser) {
    const ok = await toast.confirm({
      title: `Delete ${u.name}?`,
      destructive: true,
      confirmLabel: "Delete user",
      body: (
        <>
          <p>
            <b className="text-text-primary">{u.email}</b>
            {u.city ? ` — ${u.city} manager` : " — administrator"}.
          </p>
          <p>
            Their login is removed for good. Variances they closed or submitted keep
            their audit trail, but the name behind it will no longer resolve.
          </p>
          <p className="text-text-muted">
            To block access without losing the record, deactivate them instead.
          </p>
        </>
      ),
    });
    if (!ok) return;
    try {
      await deleteUser(u.id);
      toast.success(`${u.name} deleted.`);
      refetch();
    } catch (err) {
      toast.error(`Could not delete ${u.name}.`, { detail: errText(err) });
    }
  }

  return (
    <div className="p-container-margin">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:justify-between md:items-end mb-6">
        <div>
          <p className="text-text-muted text-sm mb-2">Operational Personnel Overview</p>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
            <div className="card px-4 py-3 flex items-center gap-3">
              <div className="w-10 h-10 rounded-control bg-accent flex items-center justify-center shrink-0">
                <Icon name="group" size={22} className="text-on-accent" />
              </div>
              <div>
                <p className="text-xs text-text-muted">Total Users</p>
                <p className="text-lg font-bold text-text-primary">{users.length}</p>
              </div>
            </div>
            <div className="card px-4 py-3 flex items-center gap-3">
              <div className="w-10 h-10 rounded-control bg-success-soft flex items-center justify-center shrink-0">
                <Icon name="verified_user" size={22} className="text-success" />
              </div>
              <div>
                <p className="text-xs text-text-muted">Active Now</p>
                <p className="text-lg font-bold text-text-primary">{active}</p>
              </div>
            </div>
            <div className="relative self-stretch sm:self-center">
              <Icon name="search" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search operations team..."
                className="input-clean pl-9 w-full sm:w-[280px]"
              />
            </div>
          </div>
        </div>
        <button onClick={openCreate} className="btn btn-primary shrink-0">
          <Icon name="person_add" size={18} />
          Add User
        </button>
      </div>

      {/* Users table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-clean">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>City Assigned</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-surface-elevated flex items-center justify-center font-bold text-text-secondary text-xs shrink-0">
                        {u.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
                      </div>
                      <span className="text-sm font-medium">{u.name}</span>
                    </div>
                  </td>
                  <td className="text-text-secondary">{u.email}</td>
                  <td>
                    <span className={`${u.role === "admin" ? "badge bg-accent text-on-accent" : "badge badge-suppressed"} uppercase`}>
                      {u.role}
                    </span>
                  </td>
                  <td>{u.city ?? "All Cities"}</td>
                  <td>
                    <span className={`flex items-center gap-1.5 text-sm ${u.status === "active" ? "text-success" : "text-text-disabled"}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${u.status === "active" ? "bg-success" : "bg-text-disabled"}`}></span>
                      {u.status === "active" ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button onClick={() => openEdit(u)} className="btn btn-compact btn-secondary" title="Manage user">
                      Manage
                    </button>
                    <button
                      onClick={() => toggleStatus(u)}
                      className="btn-icon"
                      title={u.status === "active" ? "Deactivate" : "Activate"}
                    >
                      <Icon name={u.status === "active" ? "lock" : "check_circle"} size={18} />
                    </button>
                    <button onClick={() => handleDelete(u)} className="btn-icon hover:text-danger" title="Delete user">
                      <Icon name="delete" size={18} />
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-10 text-text-muted">
                    {error ? <span className="text-danger">{error}</span> : "No users found."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 bg-surface-elevated flex justify-between items-center border-t border-border">
          <p className="text-xs text-text-muted">
            {loading ? "Loading…" : `Showing ${rows.length} of ${users.length} users`}
          </p>
        </div>
      </div>

      {/* Create / edit dialog. This was the one panel in the app that wasn't on
          the shared primitive — hand-rolled overlay, no Escape, no focus trap,
          no scroll lock, and an overlay tint (#1a1a2e at 40%) that barely dimmed
          a dark page. Moving it onto <Modal> fixes all of that at once. */}
      <Modal
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        title={form.id === null ? "Add New User" : "Manage User"}
        subtitle={form.id === null ? undefined : form.email}
        icon={form.id === null ? "person_add" : "person"}
        size="md"
        mobile="fullscreen"
        bodyClassName="p-0"
        footer={
          <div className="flex gap-3">
            <button type="button" onClick={() => setPanelOpen(false)} className="btn btn-secondary flex-1">
              Cancel
            </button>
            <button
              type="submit"
              form="user-form"
              disabled={busy}
              className="btn btn-primary flex-1 disabled:opacity-50"
            >
              <Icon
                name={busy ? "progress_activity" : "check"}
                size={18}
                className={busy ? "animate-spin" : ""}
              />
              {busy ? "Saving…" : form.id === null ? "Create User" : "Save Changes"}
            </button>
          </div>
        }
      >
            {/* The submit button lives in the Modal footer, outside this form's
                DOM subtree, so it reaches back via form="user-form". */}
            <form id="user-form" onSubmit={handleSave}>
              <div className="p-container-margin space-y-6">
                {formError && (
                  <p
                    role="alert"
                    className="text-sm text-danger bg-danger-soft border border-danger/20 rounded-control px-3 py-2"
                  >
                    {formError}
                  </p>
                )}
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-2">Full Name</label>
                  <input
                    type="text" required value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. Rahul Verma" className="input-clean w-full h-auto p-3"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-2">Work Email</label>
                  <input
                    type="email" required value={form.email} disabled={form.id !== null}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="rahul.v@cityfurnish.com"
                    className="input-clean w-full h-auto p-3 disabled:opacity-60"
                  />
                </div>
                {form.id === null && (
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-2">
                      Initial Password <span className="text-text-muted">(min 8 chars — share it with them)</span>
                    </label>
                    <input
                      type="text" required minLength={8} value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      placeholder="Set a starter password" className="input-clean w-full h-auto p-3 font-mono"
                    />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-2">Role</label>
                    <select
                      value={form.role}
                      onChange={(e) => setForm({ ...form, role: e.target.value as FormRole })}
                      className="input-clean w-full h-auto p-3 cursor-pointer"
                    >
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-2">City Assigned</label>
                    <select
                      value={form.city} disabled={form.role === "admin"}
                      onChange={(e) => setForm({ ...form, city: e.target.value as City })}
                      className="input-clean w-full h-auto p-3 cursor-pointer disabled:opacity-50"
                    >
                      {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
                {form.id !== null && (
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-2">Status</label>
                    <select
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "inactive" })}
                      className="input-clean w-full h-auto p-3 cursor-pointer"
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                )}
                <div className="bg-surface-elevated p-4 rounded-card border border-border">
                  <p className="text-sm text-text-secondary">
                    Managers see only their assigned city&apos;s variances and can close them with a
                    reason. Admins see all cities. {form.id === null && "The account is created ready to log in — hand the password over."}
                  </p>
                </div>
              </div>
            </form>
      </Modal>
    </div>
  );
}
