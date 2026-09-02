import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Anon-key server client — respects RLS, safe for user-scoped queries.
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  // Service-role client uses createServerClient with no cookie store —
  // it acts as a super-user, so session cookies are irrelevant.
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceRoleKey,
    { cookies: { getAll: () => [], setAll: () => {} } }
  );
}
