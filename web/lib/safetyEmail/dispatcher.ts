// M3.2 — the safety email dispatcher core (claim → send → record).
//
// Durability lives in Postgres: safety_email_claim leases due intents
// (FOR UPDATE SKIP LOCKED) and safety_email_record_result records exactly
// what the provider said. The provider call happens here, between the two,
// never inside a clinical transaction. If this process dies after the
// provider accepted but before recording, the lease expires and the intent
// is retried with the SAME idempotency key (the provider deduplicates).
//
// Production calls this with `scope: null` (every eligible due intent).
// The explicit outbox-id scope exists for exactly-scoped harness runs; the
// HTTP route never accepts it from a caller.
//
// No runtime imports: the authoritative worker tests load this exact code.
import type { SafetyEmailMessage, SafetyEmailProvider, SafetyEmailSendResult } from "./provider";

export type DispatchRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

export type ClaimRow = {
  outbox_id: string;
  claim_token: string;
  idempotency_key: string;
  attempt_no: number;
  tier: "clinician_review" | "urgent_clinician_review";
  recipient_id: string;
  recipient_email: string;
  organization_name: string | null;
};

export type DispatchSummary = {
  claimed: number;
  accepted: number;
  retry_scheduled: number;
  failed_permanent: number;
  stale: number;
  record_failed: number;
  batches: number;
  duration_ms: number;
};

export type DispatchOptions = {
  rpc: DispatchRpc;
  provider: SafetyEmailProvider;
  render: (claim: ClaimRow) => SafetyEmailMessage;
  scope: string[] | null;
  limit?: number;
  leaseSeconds?: number;
  maxBatches?: number;
  log?: (line: Record<string, unknown>) => void;
  // Test seam: runs after the provider answered and before the result is
  // recorded; throwing simulates a worker crash in exactly that window.
  afterSend?: (claim: ClaimRow, result: SafetyEmailSendResult) => void | Promise<void>;
};

function outcomeOf(result: SafetyEmailSendResult): { outcome: string; messageId: string | null; code: string | null } {
  switch (result.kind) {
    case "accepted": return { outcome: "provider_accepted", messageId: result.providerMessageId, code: null };
    case "permanent": return { outcome: "rejected_permanent", messageId: null, code: result.code };
    case "transient": return { outcome: "transient_error", messageId: null, code: result.code };
    case "ambiguous": return { outcome: "timeout_ambiguous", messageId: null, code: result.code };
  }
}

export async function dispatchSafetyEmails(opts: DispatchOptions): Promise<DispatchSummary> {
  const started = Date.now();
  const limit = opts.limit ?? 10;
  const leaseSeconds = opts.leaseSeconds ?? 120;
  const maxBatches = opts.maxBatches ?? 5;
  const log = opts.log ?? (() => {});
  const s: DispatchSummary = { claimed: 0, accepted: 0, retry_scheduled: 0, failed_permanent: 0, stale: 0, record_failed: 0, batches: 0, duration_ms: 0 };

  for (let batch = 0; batch < maxBatches; batch++) {
    const { data, error } = await opts.rpc("safety_email_claim", {
      p_limit: limit, p_lease_seconds: leaseSeconds, p_only_outbox_ids: opts.scope,
    });
    if (error) throw new Error(`safety_email_claim failed: ${error.message}`);
    const claims = (data ?? []) as ClaimRow[];
    s.batches++;
    if (claims.length === 0) break;
    s.claimed += claims.length;

    for (const claim of claims) {
      let result: SafetyEmailSendResult;
      try {
        result = await opts.provider.send(opts.render(claim), { idempotencyKey: claim.idempotency_key });
      } catch {
        result = { kind: "ambiguous", code: "provider_call_failed" };
      }
      await opts.afterSend?.(claim, result);
      const o = outcomeOf(result);
      const rec = await opts.rpc("safety_email_record_result", {
        p_outbox_id: claim.outbox_id, p_claim_token: claim.claim_token, p_outcome: o.outcome,
        p_http_status: result.httpStatus ?? null, p_provider_message_id: o.messageId, p_error_code: o.code,
      });
      if (rec.error) {
        // Not recorded: the lease will expire and the intent is retried with
        // the same idempotency key.
        s.record_failed++;
        log({ event: "tenotrainer.safety_dispatch.record_failed", outbox_id: claim.outbox_id, attempt: claim.attempt_no });
        continue;
      }
      const r = rec.data as { result?: string; status?: string } | null;
      if (r?.result === "stale_claim") s.stale++;
      else if (r?.status === "provider_accepted") s.accepted++;
      else if (r?.status === "retry_scheduled") s.retry_scheduled++;
      else if (r?.status === "failed_permanent") s.failed_permanent++;
      log({ event: "tenotrainer.safety_dispatch.attempt", outbox_id: claim.outbox_id, attempt: claim.attempt_no, tier: claim.tier,
            outcome: o.outcome, code: o.code, recorded: r?.result ?? null, status: r?.status ?? null });
    }
    if (claims.length < limit) break;
  }
  s.duration_ms = Date.now() - started;
  return s;
}
