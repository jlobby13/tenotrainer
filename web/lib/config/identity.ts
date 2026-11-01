// M3.3 S3 — Supabase project identity and resource-registry primitives.
// Pure: no I/O. The committed registry (web/config/resourceIdentity.json)
// is allow-list / deny-list information only; the runtime configuration is
// always the authority.
import registryJson from "../../config/resourceIdentity.json" with { type: "json" };
import type { ResourceIdentityRegistry, SupabaseKind } from "./types";
import { isLoopbackHost } from "./origin";

function stringList(v: unknown): readonly string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error("resourceIdentity.json: every list must be an array of strings");
  return Object.freeze([...v]);
}

export const RESOURCE_IDENTITY: ResourceIdentityRegistry = Object.freeze({
  developmentSupabaseProjects: stringList(registryJson.developmentSupabaseProjects),
  productionSupabaseProjects: stringList(registryJson.productionSupabaseProjects),
  developmentEmailDomains: stringList(registryJson.developmentEmailDomains),
  productionEmailDomains: stringList(registryJson.productionEmailDomains),
});

// Hosted Supabase project refs are 20 lowercase letters.
export const PROJECT_REF_PATTERN = /^[a-z]{20}$/;

export type SupabaseUrlParse =
  | { ok: true; kind: SupabaseKind; ref: string | null; url: string }
  | { ok: false; rule: string };

// hosted: exactly https://<ref>.supabase.co. local: a loopback host (the
// Supabase CLI stack). Anything else — including custom Supabase domains,
// unsupported in v1 — is not accepted.
export function parseSupabaseUrl(raw: string): SupabaseUrlParse {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, rule: "must be an absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, rule: "must be an absolute http(s) URL" };
  if (url.origin !== raw) return { ok: false, rule: "must be the bare project URL (no path, trailing slash, query or user info)" };
  const hosted = /^([a-z]{20})\.supabase\.co$/.exec(url.hostname);
  if (hosted && url.protocol === "https:" && url.port === "") return { ok: true, kind: "hosted", ref: hosted[1], url: url.origin };
  if (isLoopbackHost(url.hostname)) return { ok: true, kind: "local", ref: null, url: url.origin };
  return { ok: false, rule: "must be https://<project-ref>.supabase.co or a local (loopback) Supabase" };
}

export type SupabaseKeyKind =
  | { format: "jwt"; role: string | null; ref: string | null }
  | { format: "publishable" }
  | { format: "secret" }
  | { format: "unknown" };

function decodeBase64Url(segment: string): string | null {
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

// Classifies a Supabase API key WITHOUT verifying it (no signing secret is
// available or needed): legacy JWT keys carry role/ref claims; new-format
// keys carry only their type prefix (no project ref — a documented limit).
export function classifySupabaseKey(raw: string): SupabaseKeyKind {
  if (raw.startsWith("sb_publishable_")) return { format: "publishable" };
  if (raw.startsWith("sb_secret_")) return { format: "secret" };
  const parts = raw.split(".");
  if (parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
    const payload = decodeBase64Url(parts[1]);
    if (payload !== null) {
      try {
        const claims = JSON.parse(payload) as Record<string, unknown>;
        if (claims && typeof claims === "object") {
          return {
            format: "jwt",
            role: typeof claims.role === "string" ? claims.role : null,
            ref: typeof claims.ref === "string" ? claims.ref : null,
          };
        }
      } catch {
        // not a JWT payload
      }
    }
  }
  return { format: "unknown" };
}

// Whether `domain` is one of `domains` or a subdomain of one.
export function domainIn(domain: string, domains: readonly string[]): boolean {
  const d = domain.toLowerCase();
  return domains.some((x) => d === x.toLowerCase() || d.endsWith(`.${x.toLowerCase()}`));
}
