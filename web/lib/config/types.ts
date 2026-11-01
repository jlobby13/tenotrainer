// M3.3 S3 — the shapes of the validated application configuration.
// Types only: no runtime code, safe to import from anywhere.

export type OperatingMode = "development" | "production" | "maintenance";
export const OPERATING_MODES: readonly OperatingMode[] = ["development", "production", "maintenance"];

// Application email delivery (safety notifications and invitations).
// "disabled" is the development default; "fake" is a development-only test
// double; production and maintenance require "resend".
export type EmailProviderName = "disabled" | "fake" | "resend";

export type SupabaseKind = "hosted" | "local";

export type SupabasePublicConfig = {
  url: string;
  anonKey: string;
  kind: SupabaseKind;
  // The project ref of a hosted project (null for local Supabase).
  ref: string | null;
};

export type ResourceIdentityRegistry = {
  developmentSupabaseProjects: readonly string[];
  productionSupabaseProjects: readonly string[];
  developmentEmailDomains: readonly string[];
  productionEmailDomains: readonly string[];
};

type BaseConfig = {
  // The canonical application origin (exact serialization, e.g.
  // "https://app.example.com" — no path or trailing slash).
  appOrigin: string;
  supabase: SupabasePublicConfig;
  // Raw gate intent (interpreted per mode by operatingMode.ts).
  runtimeGate: boolean;
  publishGate: boolean;
  email: { provider: EmailProviderName; from: string | null };
  // Whether the internal dispatch endpoint can authenticate at all (never the value).
  safetyDispatchConfigured: boolean;
  platform: { isDevServer: boolean };
  // Non-fatal notices for the startup log (names only, never values).
  warnings: readonly string[];
};

export type DevelopmentConfig = BaseConfig & {
  mode: "development";
  isolatedTestProfile: false;
  // Legacy FastAPI bridge (development only until its retirement).
  legacyBridge: { fastapiUrl: string };
  fakeProvider: { logPath: string | undefined; scriptPath: string | undefined };
};

export type ProductionConfig = BaseConfig & {
  mode: "production" | "maintenance";
  // Test infrastructure only (see parse.ts): a production/maintenance
  // process verified on an isolated port with a reserved .test origin.
  isolatedTestProfile: boolean;
};

export type AppConfig = DevelopmentConfig | ProductionConfig;
