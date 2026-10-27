import "server-only";

// M2 — minimal clinician–patient assignment management for clinician_admin /
// super_user (founder D4/D6): Patient -> assigned clinicians -> add a
// clinician / end an assignment. Writes go only through the server-only RPCs
// admin_add_assignment / end_assignment, which re-check the actor's
// administrative role in the assignment's organization; this module only
// composes reads for the page. Within one organization only — there is no
// cross-organization transfer here (not defined as product policy yet).

import { createServiceRoleClient } from "./supabase/server";
import { assertMutationAllowed } from "./operatingMode";

type Admin = ReturnType<typeof createServiceRoleClient>;

export type AdminOrganization = { id: string; name: string };

export async function adminOrganizations(userId: string): Promise<AdminOrganization[]> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("organization_members")
    .select("organization_id, organizations(name)")
    .eq("user_id", userId)
    .in("role", ["clinician_admin", "super_user"]);
  return (data ?? []).map((m) => ({
    id: m.organization_id as string,
    name: (m.organizations as unknown as { name: string } | null)?.name ?? "Organization",
  }));
}

async function emailsById(admin: Admin, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = new Set(ids);
  for (let page = 1; wanted.size > out.size && page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data?.users?.length) break;
    for (const u of data.users) if (wanted.has(u.id)) out.set(u.id, u.email ?? "");
    if (data.users.length < 1000) break;
  }
  return out;
}

async function namesById(admin: Admin, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data } = await admin.from("profiles").select("id, name").in("id", ids);
  return new Map((data ?? []).map((p) => [p.id as string, ((p.name as string | null) ?? "").trim()]));
}

export type OrgPerson = { id: string; name: string; email: string };

async function members(orgId: string, roles: string[]): Promise<OrgPerson[]> {
  const admin = createServiceRoleClient();
  const { data } = await admin.from("organization_members").select("user_id").eq("organization_id", orgId).in("role", roles);
  const ids = (data ?? []).map((m) => m.user_id as string);
  const [names, emails] = await Promise.all([namesById(admin, ids), emailsById(admin, ids)]);
  return ids
    .map((id) => ({ id, name: names.get(id) || emails.get(id) || "Unnamed", email: emails.get(id) ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listOrgPatients(orgId: string): Promise<OrgPerson[]> {
  return members(orgId, ["member", "tester"]);
}

export function listOrgClinicians(orgId: string): Promise<OrgPerson[]> {
  return members(orgId, ["clinician", "clinician_admin"]);
}

export type AssignmentRow = {
  id: string;
  clinicianId: string;
  clinicianName: string;
  status: "active" | "dismissed";
  assignedAt: string;
  createdByName: string | null;
  viaInvitation: boolean;
  dismissedAt: string | null;
  dismissedByName: string | null;
  dismissedReason: string | null;
};

// Every assignment period of this patient in this organization (active and
// ended), newest first. History is never deleted.
export async function getPatientAssignments(orgId: string, patientId: string): Promise<AssignmentRow[]> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("supervisor_patients")
    .select("id, supervisor_id, status, assigned_at, created_by, source_invitation_id, dismissed_at, dismissed_by, dismissed_reason")
    .eq("organization_id", orgId)
    .eq("patient_id", patientId)
    .order("assigned_at", { ascending: false });
  const rows = data ?? [];
  const ids = [...new Set(rows.flatMap((r) => [r.supervisor_id, r.created_by, r.dismissed_by]).filter(Boolean) as string[])];
  const names = await namesById(admin, ids);
  return rows.map((r) => ({
    id: r.id as string,
    clinicianId: r.supervisor_id as string,
    clinicianName: names.get(r.supervisor_id as string) || "Unnamed clinician",
    status: r.status as "active" | "dismissed",
    assignedAt: r.assigned_at as string,
    createdByName: r.created_by ? names.get(r.created_by as string) || null : null,
    viaInvitation: r.source_invitation_id != null,
    dismissedAt: (r.dismissed_at as string | null) ?? null,
    dismissedByName: r.dismissed_by ? names.get(r.dismissed_by as string) || null : null,
    dismissedReason: (r.dismissed_reason as string | null) ?? null,
  }));
}

export type AssignmentChangeResult = string;

export async function addAssignment(actorId: string, orgId: string, clinicianId: string, patientId: string): Promise<AssignmentChangeResult> {
  // M3.1 — clinical mutation: refused in maintenance mode (defense in depth).
  assertMutationAllowed();
  const admin = createServiceRoleClient();
  const { data, error } = await admin.rpc("admin_add_assignment", {
    p_actor_id: actorId,
    p_organization_id: orgId,
    p_clinician_id: clinicianId,
    p_patient_id: patientId,
  });
  if (error) return "error";
  return ((data as Record<string, unknown>)?.result as string) ?? "error";
}

export async function endAssignment(actorId: string, assignmentId: string, reason: string): Promise<AssignmentChangeResult> {
  // M3.1 — clinical mutation: refused in maintenance mode (defense in depth).
  assertMutationAllowed();
  const admin = createServiceRoleClient();
  const { data, error } = await admin.rpc("end_assignment", { p_actor_id: actorId, p_assignment_id: assignmentId, p_reason: reason });
  if (error) return "error";
  return ((data as Record<string, unknown>)?.result as string) ?? "error";
}
