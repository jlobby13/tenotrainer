// M3.1 — fail-closed startup validation. register() runs once before the
// server handles requests. The validation (and its process.exit) lives in
// instrumentation-node.ts and is imported only for the Node.js runtime, the
// documented Next.js pattern: the Edge bundle never includes Node-only code.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    registerNode();
  }
}
