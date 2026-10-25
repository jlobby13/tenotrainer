import "server-only";

// M2 — patient in-app program notices. Reads the existing notification facts
// written by the authoritative database functions (pause_prescription,
// resume_prescription, publish_prescription_draft). Fixed neutral copy per
// type — no email, no push, no generated clinical interpretation. read_at is
// the single read/dismissed state. The patient id is always the
// authenticated session's (requireC5Patient), never the request's.

import { createServiceRoleClient } from "./supabase/server";

export type ProgramNoticeType = "prescription_paused" | "prescription_resumed" | "prescription_published" | "prescription_updated";

export type ProgramNotice = { id: string; type: ProgramNoticeType; createdAt: string; message: string };

export const PROGRAM_NOTICE_COPY: Record<ProgramNoticeType, string> = {
  prescription_paused:
    "Your clinician has paused your program. New sessions are unavailable until it is resumed. A session you already started can still be finished.",
  prescription_resumed: "Your clinician has resumed your program.",
  prescription_published: "Your clinician has shared your program.",
  prescription_updated: "Your clinician has updated your program.",
};

const NOTICE_LIMIT = 5;

export async function getUnreadProgramNotices(patientId: string): Promise<ProgramNotice[]> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("notifications")
    .select("id, type, created_at")
    .eq("patient_id", patientId)
    .is("read_at", null)
    .in("type", Object.keys(PROGRAM_NOTICE_COPY))
    .order("created_at", { ascending: false })
    .limit(NOTICE_LIMIT);
  return (data ?? []).map((n) => ({
    id: n.id as string,
    type: n.type as ProgramNoticeType,
    createdAt: n.created_at as string,
    message: PROGRAM_NOTICE_COPY[n.type as ProgramNoticeType],
  }));
}

// Idempotent: an already-read (or someone else's) notice is left untouched.
export async function dismissProgramNotice(patientId: string, noticeId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(noticeId)) return;
  const admin = createServiceRoleClient();
  await admin.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", noticeId).eq("patient_id", patientId).is("read_at", null);
}
