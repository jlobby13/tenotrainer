import crypto from "crypto";

export type BridgePayload = {
  email: string;
  supabaseId: string;
  fastapiRole: string;
  name: string;
  expires: number;
  used: boolean;
};

// In-memory store — single-instance dev bridge. Tokens expire in 60 seconds.
const store = new Map<string, BridgePayload>();

// Purge stale entries every 2 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expires < now) store.delete(k);
    }
  },
  2 * 60 * 1000
);

export const FASTAPI_ROLE: Record<string, string> = {
  tester: "patient",
  member: "patient",
  clinician: "supervisor",
  clinician_admin: "supervisor",
  super_user: "superuser",
};

export function createBridgeToken(email: string, supabaseId: string, fastapiRole: string, name: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  store.set(token, { email, supabaseId, fastapiRole, name, expires: Date.now() + 60_000, used: false });
  return token;
}

export function consumeBridgeToken(token: string): BridgePayload | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.used) return null;
  if (entry.expires < Date.now()) {
    store.delete(token);
    return null;
  }
  entry.used = true;
  setTimeout(() => store.delete(token), 5_000);
  return entry;
}
