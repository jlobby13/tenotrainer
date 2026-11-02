// D1 — operator provisioning CLI: the ONLY production path that creates the
// initial organization, its initial super user and clinician staff
// accounts. /setup is development-only. See
// docs/m3-production-provisioning.md for the full procedure.
//
//   node --env-file=<owner-only env file> scripts/provisionStaff.mjs \
//     --plan <plan.json> --target-ref <project-ref> \
//     [--passwords-file <passwords.json>] [--apply] [--json]
//
// Credentials come only from the process environment (SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY) — never from arguments, and no .env file is
// read implicitly. Without --apply this is a dry run: it validates
// everything, reads the target, and writes nothing.
//
// Exit codes: 0 applied / no change / dry run would apply, 1 unexpected
// error, 2 refused (usage, validation, identity, conflict or a missing
// password) before any write, 3 stopped after a partial write (rerun after
// review; see the procedure).
import { register } from "node:module";

// Loads the app's real S3 identity module (type stripping; Node may print a
// harmless MODULE_TYPELESS_PACKAGE_JSON notice on stderr).
register("./lib/tsServerModuleHooks.mjs", import.meta.url);

const { createClient } = await import("@supabase/supabase-js");
const core = await import("./lib/operatorProvisioning.mjs");

const USAGE = "usage: provisionStaff.mjs --plan <file> --target-ref <ref> [--passwords-file <file>] [--apply] [--json]";
const VALUE_FLAGS = new Set(["--plan", "--target-ref", "--passwords-file"]);
const BOOL_FLAGS = new Set(["--apply", "--json"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new core.ProvisioningRefused(`${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    } else if (BOOL_FLAGS.has(a)) {
      out[a.slice(2)] = true;
    } else {
      // Unknown arguments are refused (secrets are never accepted as arguments).
      throw new core.ProvisioningRefused(`unknown argument (${USAGE})`);
    }
  }
  return out;
}

const secrets = [process.env.SUPABASE_SERVICE_ROLE_KEY].filter(Boolean);
let redact = core.createRedactor(secrets);
const say = (line) => console.log(redact(line));

function printReport(report, target, plan) {
  say(`TenoTrainer operator provisioning — ${report.mode === "apply" ? "APPLY" : "DRY RUN (no changes)"}`);
  say(`target: ${target.intent} project ${target.ref} (${target.url}); credential: ${target.keyFormat}`);
  for (const s of report.steps) {
    if (s.kind === "organization") {
      say(`organization '${s.slug}' (${plan.organization.name}) id ${s.id}: ${s.status}${s.reason ? ` — ${s.reason}` : ""}`);
    } else {
      const detail = s.status === "refuse" ? `REFUSED — ${s.reason}` : `account ${s.account}; membership ${s.role} ${s.membership}; password ${s.password}`;
      say(`${s.kind === "super_user" ? "super user" : "clinician"} ${s.email}: ${detail}`);
    }
  }
  say(`writes: ${report.writes}`);
  say(`result: ${report.outcome}${report.reason ? ` — ${report.reason}` : ""}`);
  if (report.outcome === "partial_refused" || report.outcome === "partial_failed") {
    say("partial state: privileges are granted only by the membership row, which was not written for the stopped account. Review, then rerun the same plan.");
  }
}

let exitCode = 0;
try {
  const args = parseArgs(process.argv.slice(2));
  const plan = core.validatePlan(core.readPlanFile(args.plan));
  const target = core.resolveTarget({ plan, targetRefArg: args["target-ref"], env: process.env });
  const passwords = core.readPasswordsFile(args["passwords-file"], plan);
  redact = core.createRedactor([...secrets, ...passwords.values()]);
  const admin = createClient(target.url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const report = await core.provision({ plan, target, store: core.supabaseStore(admin), passwords, apply: !!args.apply });
  if (args.json) say(JSON.stringify(report));
  else printReport(report, target, plan);
  exitCode = { refused: 2, blocked_missing_passwords: 2, partial_refused: 3, partial_failed: 3, failed: 1 }[report.outcome] ?? 0;
} catch (e) {
  if (e instanceof core.ProvisioningRefused) {
    say(`refused: ${e.message}`);
    exitCode = e.afterWrites ? 3 : 2;
  } else {
    say(`error: ${e?.message ?? e}`);
    exitCode = 1;
  }
}
process.exitCode = exitCode;
