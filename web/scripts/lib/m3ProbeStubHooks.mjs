// M3.1 — test-only resolve hook for m3MaintenanceLibraryProbe.mjs: replaces
// Next's navigation/cache modules (which need the Next runtime) with inert
// stubs, so the clinical libraries can be imported in plain Node. Never
// imported by application code.
const STUBS = {
  "next/navigation": "export function redirect(u){throw new Error('redirect:'+u)} export function notFound(){throw new Error('notFound')}",
  "next/cache": "export function revalidatePath(){} export function revalidateTag(){}",
};
export async function resolve(specifier, context, nextResolve) {
  const key = specifier.replace(/\.js$/, "");
  if (key in STUBS) return { url: `data:text/javascript,${encodeURIComponent(STUBS[key])}`, shortCircuit: true };
  return nextResolve(specifier, context);
}
