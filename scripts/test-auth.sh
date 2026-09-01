#!/usr/bin/env bash
# =============================================================================
# TenoTrainer — auth flow smoke tests
# Tests what can be verified without a browser session (route behaviour,
# redirects, protected-route guards, session persistence via Supabase Auth API).
#
# Usage:
#   bash scripts/test-auth.sh [TEST_EMAIL] [TEST_PASSWORD]
#
# If TEST_EMAIL / TEST_PASSWORD are omitted the script only runs the
# unauthenticated checks and skips the session-based tests.
# =============================================================================

BASE="http://localhost:3000"
SUPABASE_URL="https://kpdxlzqtvueiytwjamiw.supabase.co"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtwZHhsenF0dnVlaXl0d2phbWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyMTEwNDMsImV4cCI6MjEwMzc4NzA0M30.sQy47uKsBw3-tHdwRvriP9q9V9YbiTbo6m6qbhAdaK8"

TEST_EMAIL="${1:-}"
TEST_PASSWORD="${2:-}"

PASS=0
FAIL=0
COOKIE_JAR=$(mktemp)

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS+1))
  else
    echo "  ✗ $desc (got: $got, want: $want)"
    FAIL=$((FAIL+1))
  fi
}

section() { echo; echo "── $1 ──────────────────────────────────"; }

# ─── Server running? ──────────────────────────────────────────────────────────
section "Pre-flight"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/login")
if [ "$STATUS" != "200" ]; then
  echo "  ✗ Next.js server not reachable at $BASE (got $STATUS)"
  echo "    Start with: cd web && npm run dev"
  exit 1
fi
echo "  ✓ Server reachable at $BASE"

# ─── Unauthenticated route behaviour ─────────────────────────────────────────
section "Unauthenticated route guards"

code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/")
check "GET / — redirects (to /dashboard, then /login)" "$code" "307"

code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/login")
check "GET /login — public, 200" "$code" "200"

code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/register")
check "GET /register — public, 200" "$code" "200"

code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/register/confirm")
check "GET /register/confirm — public, 200" "$code" "200"

code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/dashboard")
check "GET /dashboard — 307 redirect (unauthenticated)" "$code" "307"

location=$(curl -s -o /dev/null -w "%{redirect_url}" "$BASE/dashboard")
check "  redirect_url contains /login" "$(echo "$location" | grep -c '/login')" "1"

code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/auth/debug")
check "GET /api/auth/debug — 401 (unauthenticated)" "$code" "401"

# ─── Login page content ───────────────────────────────────────────────────────
section "Login page content"

body=$(curl -s "$BASE/login")
check "Login page: TenoTrainer brand present" "$(echo "$body" | grep -c 'TenoTrainer')" "1"
check "Login page: email field present" "$(echo "$body" | grep -c 'type="email"')" "1"
check "Login page: password field present" "$(echo "$body" | grep -c 'type="password"')" "1"
check "Login page: register link present" "$(echo "$body" | grep -c '/register')" "1"

# ─── Session-based tests (requires test credentials) ─────────────────────────
if [ -z "$TEST_EMAIL" ] || [ -z "$TEST_PASSWORD" ]; then
  echo
  echo "── Session tests skipped ──────────────────────────────────────────────"
  echo "   Pass TEST_EMAIL and TEST_PASSWORD to run session-based checks:"
  echo "   bash scripts/test-auth.sh user@example.com password123"
  echo
else
  section "Supabase Auth — sign in via REST API"

  # Sign in via Supabase Auth REST to get access + refresh tokens
  AUTH_RESP=$(curl -s -X POST \
    "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")

  ACCESS_TOKEN=$(echo "$AUTH_RESP" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
  REFRESH_TOKEN=$(echo "$AUTH_RESP" | grep -o '"refresh_token":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$ACCESS_TOKEN" ]; then
    echo "  ✗ Sign-in failed — check credentials and that the user exists in Supabase Auth"
    echo "    Response: $AUTH_RESP"
  else
    echo "  ✓ Supabase Auth issued access token"

    # Supabase SSR stores session in cookies named sb-<ref>-auth-token.0 / .1
    PROJECT_REF="kpdxlzqtvueiytwjamiw"
    SESSION_JSON="{\"access_token\":\"$ACCESS_TOKEN\",\"refresh_token\":\"$REFRESH_TOKEN\",\"token_type\":\"bearer\"}"
    SESSION_B64=$(echo -n "$SESSION_JSON" | base64 -w 0 2>/dev/null || echo -n "$SESSION_JSON" | base64)

    # Hit the debug endpoint with a Bearer token header (fallback if cookie doesn't work in curl)
    DEBUG_RESP=$(curl -s "$BASE/api/auth/debug" \
      -H "Authorization: Bearer $ACCESS_TOKEN")

    # The debug endpoint uses the cookie-based client, not the Authorization header,
    # so the above won't be authenticated. Instead confirm the Supabase API confirms the user.
    USER_RESP=$(curl -s "$SUPABASE_URL/auth/v1/user" \
      -H "apikey: $ANON_KEY" \
      -H "Authorization: Bearer $ACCESS_TOKEN")

    USER_ID=$(echo "$USER_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    USER_EMAIL=$(echo "$USER_RESP" | grep -o '"email":"[^"]*"' | head -1 | cut -d'"' -f4)

    check "Supabase Auth: user ID returned" "$([ -n "$USER_ID" ] && echo 1 || echo 0)" "1"
    check "Supabase Auth: email matches" "$USER_EMAIL" "$TEST_EMAIL"

    section "Profile row (via Supabase REST + service-role)"
    # Check the profiles table directly via Supabase REST (with anon key, RLS applies)
    PROFILE_RESP=$(curl -s \
      "$SUPABASE_URL/rest/v1/profiles?id=eq.$USER_ID&select=id,name,tfa_enabled,organization_id" \
      -H "apikey: $ANON_KEY" \
      -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H "Accept: application/json")

    PROFILE_COUNT=$(echo "$PROFILE_RESP" | grep -o '"id"' | wc -l | tr -d ' ')
    check "Profile row exists in public.profiles" "$PROFILE_COUNT" "1"

    PROFILE_NAME=$(echo "$PROFILE_RESP" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
    check "Profile name is non-empty" "$([ -n "$PROFILE_NAME" ] && echo 1 || echo 0)" "1"
    echo "    name: $PROFILE_NAME"

    section "Organisation membership (via Supabase REST)"
    MEMBER_RESP=$(curl -s \
      "$SUPABASE_URL/rest/v1/organization_members?user_id=eq.$USER_ID&select=organization_id,role" \
      -H "apikey: $ANON_KEY" \
      -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H "Accept: application/json")

    MEMBER_COUNT=$(echo "$MEMBER_RESP" | grep -o '"role"' | wc -l | tr -d ' ')
    if [ "$MEMBER_COUNT" -gt "0" ]; then
      echo "  ✓ Org memberships: $MEMBER_COUNT found"
      PASS=$((PASS+1))
      ROLE=$(echo "$MEMBER_RESP" | grep -o '"role":"[^"]*"' | head -1 | cut -d'"' -f4)
      echo "    role: $ROLE"
    else
      echo "  ~ No org memberships (expected for new users — will be set via invite)"
    fi

    section "Logout via Next.js /logout route"
    # Test the logout route using the Next.js session cookie flow.
    # We need to first establish a cookie session by hitting Next.js with
    # the access token cookie that Supabase SSR would normally set.
    # Simplified: just verify /logout redirects to /login.
    LOGOUT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
      "$BASE/logout")
    LOGOUT_LOC=$(curl -s -o /dev/null -w "%{redirect_url}" -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
      "$BASE/logout")
    check "GET /logout — redirects (307/302)" \
      "$([ "$LOGOUT_CODE" = "307" ] || [ "$LOGOUT_CODE" = "302" ] && echo 1 || echo 0)" "1"
    check "  redirect points to /login" "$(echo "$LOGOUT_LOC" | grep -c '/login')" "1"
  fi
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo
echo "══════════════════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  echo "All checks passed ✓"
else
  echo "Fix the failures above before proceeding."
fi
echo "══════════════════════════════════════════════"

rm -f "$COOKIE_JAR"
exit $FAIL
