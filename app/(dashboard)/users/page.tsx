"use client";

import { useMemo, useState } from "react";
import { useDemoStore } from "@/lib/demo-store";
import { CITIES, type City, type UserRole } from "@/lib/sample-data";
import { Icon } from "@/components/icon";

const ROLE_BADGE: Record<UserRole, string> = {
  ADMIN: "badge bg-accent text-white",
  MANAGER: "badge badge-suppressed",
};

export default function UsersPage() {
  const { users, addUser, removeUser } = useDemoStore();
  const [search, setSearch] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("MANAGER");
  const [city, setCity] = useState<City>("DELHI");

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

  const active = users.filter((u) => u.status === "ACTIVE").length;

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    addUser({
      name,
      email,
      role,
      city: role === "MANAGER" ? city : null,
    });
    setName("");
    setEmail("");
    setRole("MANAGER");
    setPanelOpen(false);
  }

  return (
    <div className="p-container-margin">
      {/* Header row */}
      <div className="flex flex-col gap-4 md:flex-row md:justify-between md:items-end mb-6">
        <div>
          <p className="text-text-muted text-sm mb-2">
            Operational Personnel Overview
          </p>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
            <div className="card px-4 py-3 flex items-center gap-3">
              <div className="w-10 h-10 rounded-control bg-accent flex items-center justify-center shrink-0">
                <Icon name="group" size={22} className="text-white" />
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
              <Icon
                name="search"
                size={18}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              />
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
        <button onClick={() => setPanelOpen(true)} className="btn btn-primary shrink-0">
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
                    <div className="w-8 h-8 rounded-full bg-surface-elevated flex items-center justify-center font-bold text-text-secondary text-xs">
                      {u.name
                        .split(" ")
                        .map((p) => p[0])
                        .slice(0, 2)
                        .join("")
                        .toUpperCase()}
                    </div>
                    <span className="text-sm font-medium">{u.name}</span>
                  </div>
                </td>
                <td className="text-text-secondary">{u.email}</td>
                <td>
                  <span className={`${ROLE_BADGE[u.role]} uppercase`}>
                    {u.role}
                  </span>
                </td>
                <td>{u.city ?? "All Cities"}</td>
                <td>
                  <span
                    className={`flex items-center gap-1.5 text-sm ${
                      u.status === "ACTIVE" ? "text-success" : "text-text-disabled"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        u.status === "ACTIVE" ? "bg-success" : "bg-text-disabled"
                      }`}
                    ></span>
                    {u.status === "ACTIVE" ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="text-right">
                  {u.role !== "ADMIN" && (
                    <button
                      onClick={() => removeUser(u.id)}
                      title="Remove user"
                      className="btn-icon row-action hover:text-danger"
                    >
                      <Icon name="delete" size={18} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <div className="px-4 py-3 bg-surface-elevated flex justify-between items-center border-t border-border">
          <p className="text-xs text-text-muted">
            Showing {rows.length} of {users.length} users • Provisioned from
            this management account
          </p>
        </div>
      </div>

      {/* Add User slide-in panel */}
      {panelOpen && (
        <>
          <div
            className="fixed inset-0 bg-primary-container/40 z-[60]"
            onClick={() => setPanelOpen(false)}
          ></div>
          <div className="fixed right-0 top-0 h-full w-full max-w-[440px] bg-surface-card shadow-card-hover z-[70] flex flex-col">
            <div className="p-container-margin border-b border-border flex justify-between items-center">
              <h3 className="font-headline text-lg font-bold text-text-primary">
                Add New User
              </h3>
              <button
                onClick={() => setPanelOpen(false)}
                className="btn-icon"
              >
                <Icon name="close" size={20} />
              </button>
            </div>
            <form
              onSubmit={handleSave}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <div className="flex-1 overflow-y-auto p-container-margin space-y-6">
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-2">
                    Full Name
                  </label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Rahul Verma"
                    className="input-clean w-full h-auto p-3"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-2">
                    Work Email
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="rahul.v@cityfurnish.com"
                    className="input-clean w-full h-auto p-3"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-2">
                      Role
                    </label>
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value as UserRole)}
                      className="input-clean w-full h-auto p-3 cursor-pointer"
                    >
                      <option value="MANAGER">Manager</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-2">
                      City Assigned
                    </label>
                    <select
                      value={city}
                      onChange={(e) => setCity(e.target.value as City)}
                      disabled={role === "ADMIN"}
                      className="input-clean w-full h-auto p-3 cursor-pointer disabled:opacity-50"
                    >
                      {CITIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="bg-surface-elevated p-4 rounded-card border border-border">
                  <p className="text-sm font-medium text-text-primary mb-2">
                    Account Privileges
                  </p>
                  <p className="text-sm text-text-secondary">
                    Managers see only their assigned city&apos;s variances and
                    can close them with a reason. Admins see all cities.
                    Passwords are provisioned via Supabase invite once the
                    central DB is connected.
                  </p>
                </div>
              </div>
              <div className="p-container-margin border-t border-border flex gap-3">
                <button
                  type="button"
                  onClick={() => setPanelOpen(false)}
                  className="btn btn-secondary flex-1"
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary flex-1">
                  Save User
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
