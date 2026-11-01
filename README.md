# TenoTrainer

Achilles tendinopathy rehabilitation: a Next.js application (`web/`) on
Supabase. The legacy FastAPI app (`app/`) is development-only and is being
retired.

## Configuration

The application is configured entirely at runtime through server-only
environment variables. The authoritative contract — every variable, the
development / production / maintenance matrix, canonical origin, Supabase
identity, the secret boundary, application email, readiness and preview
deployments — is **[docs/m3-configuration-contract.md](docs/m3-configuration-contract.md)**.

- Development: copy `web/.env.local.example` to `web/.env.local` and fill in
  the placeholders (`TENOTRAINER_MODE=development`; email stays `disabled`).
- Production shape (placeholders only): `web/.env.production.example`.
- Legacy FastAPI (development only): `app/.env.development.example` → root `.env`.

Operating modes and their enforcement: [docs/m3-operating-modes.md](docs/m3-operating-modes.md).

TenoTrainer is **not yet production-ready**; see the remaining production
blockers in the configuration contract.
