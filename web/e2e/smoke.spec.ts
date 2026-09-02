/**
 * Smoke tests — all HTTP-level using Playwright's `request` fixture.
 * No browser required; these run against any server at PLAYWRIGHT_BASE_URL.
 *
 * To run browser-based auth tests supply:
 *   PLAYWRIGHT_PATIENT_EMAIL=...
 *   PLAYWRIGHT_PATIENT_PASSWORD=...
 * and ensure `sudo npx playwright install --with-deps` has been run.
 */

import { test, expect } from "@playwright/test";

// ── Route protection ──────────────────────────────────────────────────────────

test.describe("unauthenticated route protection", () => {
  for (const path of [
    "/dashboard",
    "/patient/dashboard",
    "/clinician/dashboard",
    "/super/dashboard",
  ]) {
    test(`GET ${path} redirects to /login`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBeGreaterThanOrEqual(300);
      expect(response.status()).toBeLessThan(400);
      const location = response.headers()["location"] ?? "";
      expect(location).toMatch(/\/login/);
    });
  }
});

// ── Invite-only registration ──────────────────────────────────────────────────

test.describe("invite-only registration", () => {
  test("GET /register returns 200 with invite-only message", async ({ request }) => {
    const response = await request.get("/register");
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain("Invitation required");
    expect(body).toContain("invite-only");
  });

  test("GET /register response body contains no sign-up form inputs", async ({ request }) => {
    const response = await request.get("/register");
    const body = await response.text();
    // No password input means no registration form was rendered
    expect(body).not.toContain('type="password"');
    expect(body).not.toContain('name="password"');
  });
});

// ── Invitation accept page ────────────────────────────────────────────────────

test.describe("invitation accept page", () => {
  test("GET /invite/accept without token shows invalid invitation", async ({ request }) => {
    const response = await request.get("/invite/accept");
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain("Invalid invitation");
    expect(body).toContain("No invitation token was provided.");
  });

  test("GET /invite/accept with bogus token shows invalid invitation", async ({ request }) => {
    const response = await request.get("/invite/accept?token=notavalidtoken");
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain("Invalid invitation");
  });
});

// ── API guard ─────────────────────────────────────────────────────────────────

test.describe("API route protection", () => {
  test("GET /api/auth/debug returns 404 (dev-gated) or 401 in non-dev", async ({ request }) => {
    const response = await request.get("/api/auth/debug");
    // In production: 404. In dev with no session: 401.
    expect([401, 404]).toContain(response.status());
  });
});
