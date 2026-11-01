// M3.3 S3 — an opaque wrapper for secret configuration values. Logging,
// string interpolation, JSON serialization and util.inspect all yield
// "[redacted]"; the raw value is read only through reveal(), which only
// lib/config/secrets.ts may call (enforced by the static boundary test).

const REDACTED = "[redacted]";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}
