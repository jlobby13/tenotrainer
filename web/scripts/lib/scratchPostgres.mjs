// M3.4a — a throwaway local PostgreSQL cluster for the fresh-database proof
// (test infrastructure). It is never the development project: it is a new
// cluster in a fresh temporary directory, listening only on 127.0.0.1 at an
// isolated port (3190-3199), with a random password, created and destroyed
// by the suite. The Supabase CLI is never used for it, and every connection
// first proves its identity (server port, data directory, database name).
//
// Tooling: real PostgreSQL binaries and the `pg` client are NOT repository
// dependencies. Install them once, outside the repository, and point
// TENOTRAINER_PG_TOOLING at that directory:
//
//   mkdir -p ~/.cache/tenotrainer-pgtool && cd ~/.cache/tenotrainer-pgtool \
//     && npm init -y >/dev/null && npm install embedded-postgres@17.6.0-beta.15 pg@8.23.1
//
// (PostgreSQL 17.6, matching the development project's major/minor.)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRATCH_DB = "tenotrainer_scratch_m34a";

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(false); });
    s.on("error", () => resolve(true));
    s.setTimeout(1000, () => { s.destroy(); resolve(true); });
  });
}

export class ScratchPostgres {
  constructor({ tooling = process.env.TENOTRAINER_PG_TOOLING, port = 3190 } = {}) {
    if (!tooling) throw new Error("TENOTRAINER_PG_TOOLING is not set (see scripts/lib/scratchPostgres.mjs for the one-time install)");
    if (!Number.isInteger(port) || port < 3190 || port > 3199) throw new Error("scratch Postgres port must be 3190-3199");
    this.native = join(tooling, "node_modules", "@embedded-postgres", "linux-x64", "native");
    this.bin = join(this.native, "bin");
    if (!existsSync(join(this.bin, "postgres"))) throw new Error(`no PostgreSQL binaries under ${this.native}`);
    this.pg = createRequire(join(tooling, "package.json"))("pg");
    this.port = port;
    this.password = randomBytes(24).toString("hex");
  }

  async start() {
    if (!(await portFree(this.port))) throw new Error(`port ${this.port} is in use — refusing to touch a server this suite did not start`);
    this.dir = mkdtempSync(join(tmpdir(), "m34a-scratch-pg-"));
    this.data = join(this.dir, "data");
    const pwfile = join(this.dir, "pw");
    writeFileSync(pwfile, this.password, { mode: 0o600 });
    execFileSync(join(this.bin, "initdb"), ["-D", this.data, "-U", "postgres", "-A", "scram-sha-256", "--pwfile", pwfile, "-E", "UTF8", "--locale=C"], { stdio: "ignore" });
    rmSync(pwfile);
    // The pg_cron TEST DOUBLE (scratch-pg-cron/) goes into this tooling's
    // extension directory only.
    const ext = join(this.native, "share", "postgresql", "extension");
    for (const f of ["pg_cron.control", "pg_cron--1.6.sql"]) copyFileSync(join(HERE, "scratch-pg-cron", f), join(ext, f));
    execFileSync(join(this.bin, "pg_ctl"), ["-D", this.data, "-l", join(this.dir, "server.log"), "-w", "-t", "60", "-o",
      `-p ${this.port} -c listen_addresses=127.0.0.1 -k ${this.dir} -c fsync=off -c synchronous_commit=off`, "start"], { stdio: "ignore" });
    const admin = await this.connect("postgres");
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
    await admin.end();
    this.client = await this.connect(SCRATCH_DB);
    await this.assertIdentity(this.client);
    return this.client;
  }

  async connect(database) {
    const c = new this.pg.Client({ host: "127.0.0.1", port: this.port, user: "postgres", password: this.password, database });
    await c.connect();
    return c;
  }

  // Positive identification before any statement: this exact cluster.
  async assertIdentity(client) {
    const { rows } = await client.query("SELECT inet_server_port() AS port, current_setting('data_directory') AS data, current_database() AS db");
    const r = rows[0];
    if (Number(r.port) !== this.port || realpathSync(r.data) !== realpathSync(this.data) || r.db !== SCRATCH_DB) {
      throw new Error(`scratch identity check failed (${JSON.stringify(r)}) — refusing to run anything`);
    }
  }

  async stop() {
    try { await this.client?.end(); } catch { /* closed */ }
    if (this.data && existsSync(this.data)) {
      try { execFileSync(join(this.bin, "pg_ctl"), ["-D", this.data, "-m", "fast", "-w", "stop"], { stdio: "ignore" }); } catch { /* not running */ }
    }
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}
