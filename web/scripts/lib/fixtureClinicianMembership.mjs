// M3.2 — exact-id handling of the shared development fixture clinician's
// membership / assignments in the C5.6D / C5.6E / C5.6F suites.
//
// The suites borrow a long-lived development clinician account. Previously
// teardown deleted EVERY assignment of that clinician (by clinician id) —
// which would also destroy assignments the run never created. Now:
//   * the membership the run adds (only if missing) and every assignment it
//     creates are recorded by their exact row ids at creation;
//   * teardown deletes only those exact rows, checking every error;
//   * every other assignment of the clinician is snapshotted at the start
//     and must be byte-identical after teardown, or teardown throws.
export function fixtureClinicianMembership(admin, { clinicianId, organizationId }) {
  const assignmentIds = [];
  let membershipId = null;
  let snapshot = null;

  const othersNow = async () => {
    const { data, error } = await admin.from("supervisor_patients").select("*").eq("supervisor_id", clinicianId).order("id");
    if (error) throw new Error(`assignment snapshot failed: ${error.message}`);
    return (data ?? []).filter((r) => !assignmentIds.includes(r.id));
  };

  return {
    assignmentIds,
    async begin() {
      if (snapshot === null) snapshot = await othersNow();
      return snapshot.length;
    },
    async ensureMembership() {
      if (snapshot === null) await this.begin();
      if (membershipId) return;
      const { data: existing, error: e1 } = await admin.from("organization_members").select("id")
        .eq("user_id", clinicianId).eq("organization_id", organizationId).maybeSingle();
      if (e1) throw new Error(`membership lookup failed: ${e1.message}`);
      if (existing) return; // pre-existing: never ours to remove
      const { data, error } = await admin.from("organization_members")
        .insert({ organization_id: organizationId, user_id: clinicianId, role: "clinician" }).select("id").single();
      if (error) throw new Error(`membership insert failed: ${error.message}`);
      membershipId = data.id;
    },
    async assign(patientId, extra = {}) {
      const { data, error } = await admin.from("supervisor_patients")
        .insert({ organization_id: organizationId, supervisor_id: clinicianId, patient_id: patientId, status: "active", ...extra }).select("id").single();
      if (error) throw new Error(`fixture assignment insert failed: ${error.message}`);
      assignmentIds.push(data.id);
      return data.id;
    },
    // Throws on any failure (the suite must fail).
    async teardown() {
      if (assignmentIds.length) {
        const { error } = await admin.from("supervisor_patients").delete().in("id", assignmentIds);
        if (error) throw new Error(`fixture assignment cleanup failed: ${error.message}`);
        const { data: left, error: e2 } = await admin.from("supervisor_patients").select("id").in("id", assignmentIds);
        if (e2 || (left ?? []).length) throw new Error(`fixture assignments remain: ${(left ?? []).length}`);
      }
      if (membershipId) {
        const { error } = await admin.from("organization_members").delete().eq("id", membershipId);
        if (error) throw new Error(`fixture membership cleanup failed: ${error.message}`);
        membershipId = null;
      }
      if (snapshot !== null) {
        const after = await othersNow();
        if (JSON.stringify(after) !== JSON.stringify(snapshot)) {
          throw new Error(`unrelated assignments of the fixture clinician changed (${snapshot.length} before, ${after.length} after)`);
        }
      }
      return { removedAssignments: assignmentIds.length, unrelatedPreserved: snapshot?.length ?? 0 };
    },
  };
}
