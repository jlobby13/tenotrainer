// M3.3 S3 — syntactically valid but UNSIGNED Supabase-style keys for pure
// configuration-contract tests (test infrastructure only). They carry the
// role / ref claims the contract classifies; they can never authenticate.
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function fakeSupabaseJwt({ role, ref } = {}) {
  const claims = { iss: "supabase", iat: 1700000000, exp: 4000000000 };
  if (role !== undefined) claims.role = role;
  if (ref !== undefined) claims.ref = ref;
  return `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u(claims)}.unsignedtestsignature`;
}

export const fakeKeysFor = (ref) => ({
  SUPABASE_ANON_KEY: fakeSupabaseJwt({ role: "anon", ref }),
  SUPABASE_SERVICE_ROLE_KEY: fakeSupabaseJwt({ role: "service_role", ref }),
});
