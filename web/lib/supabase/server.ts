import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabasePublic } from "../config";
import { getServiceRoleKey } from "../config/secrets";

// Anon-key server client — respects RLS, safe for user-scoped queries.
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabasePublic();
  return createServerClient(
    url,
    anonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll called from a Server Component — cookies are read-only there.
          }
        },
      },
    }
  );
}

// Service-role client — bypasses RLS. ONLY call from server actions / route handlers.
// Never export or use in Client Components.
export function createServiceRoleClient() {
  // M3.3 S3 — the credential comes only from the server-only secret boundary.
  const serviceRoleKey = getServiceRoleKey();
  // Service-role client uses createServerClient with no cookie store —
  // it acts as a super-user, so session cookies are irrelevant.
  return createServerClient(
    getSupabasePublic().url,
    serviceRoleKey,
    { cookies: { getAll: () => [], setAll: () => {} } }
  );
}
