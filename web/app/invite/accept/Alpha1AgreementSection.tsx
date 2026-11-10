import { ALPHA1_AGREEMENT_SECTIONS, ALPHA1_AGREEMENT_TITLE, ALPHA1_AGREEMENT_VERSION } from "@/lib/alpha1Agreement";

// Alpha 1 — the participation agreement, shown in full inside the patient
// acceptance form (normal page scrolling; no nested scroll container).
export function Alpha1AgreementSection() {
  return (
    <section aria-labelledby="alpha1-agreement-title" data-testid="alpha1-agreement" className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm leading-relaxed text-gray-700">
      <h2 id="alpha1-agreement-title" className="text-base font-semibold text-gray-900">
        {ALPHA1_AGREEMENT_TITLE}
      </h2>
      <p className="text-xs text-gray-500" data-testid="alpha1-agreement-version">
        Version {ALPHA1_AGREEMENT_VERSION}
      </p>
      {ALPHA1_AGREEMENT_SECTIONS.map((section) => (
        <div key={section.heading} className="mt-4">
          <h3 className="font-semibold text-gray-900">{section.heading}</h3>
          {section.blocks.map((block, i) =>
            typeof block === "string" ? (
              <p key={i} className="mt-1.5">
                {block}
              </p>
            ) : "strong" in block ? (
              <p key={i} className="mt-1.5 font-semibold text-gray-900">
                {block.strong}
              </p>
            ) : (
              <ul key={i} className="mt-1.5 list-disc space-y-0.5 pl-5">
                {block.list.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )
          )}
        </div>
      ))}
    </section>
  );
}
