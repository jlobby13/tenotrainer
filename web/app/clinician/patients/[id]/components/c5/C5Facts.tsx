import Link from "next/link";
import {
  formatRpe,
  formatScore,
  morningStatusLabel,
  trainingStatusLabel,
  type C5ImmediateFact,
  type MorningFact,
  type ScoreFact,
} from "@/lib/clinicianC5";
import type { C5TrainingStatus } from "@/lib/c5RuntimeTypes";
import { PatientNav, type PatientTab } from "../PatientNav";

// M1 — shared server-rendered building blocks for the clinician C5 pages.
// Neutral presentation: no red/green judgment of performance, pain or RPE.

export function ClinicianPatientShell({
  patientId,
  displayName,
  active,
  isC5,
  children,
}: {
  patientId: string;
  displayName: string;
  active: PatientTab;
  isC5: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <Link href="/clinician/dashboard" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
          Back to Patients
        </Link>
      </nav>
      <main className="max-w-4xl mx-auto px-4 py-8 lg:py-10 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-3">{displayName}</h1>
          <PatientNav patientId={patientId} active={active} isC5={isC5} />
        </div>
        {children}
      </main>
    </div>
  );
}

export function Card({ title, children, testId }: { title?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-5 sm:p-6" data-testid={testId}>
      {title && <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</h2>}
      {children}
    </section>
  );
}

export function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-sm text-gray-500">{label}</dt>
      <dd className="text-sm font-medium text-gray-900 sm:text-right">{children}</dd>
    </div>
  );
}

// Status is stated, never coloured as good/bad. A safety stop is marked so
// it can't be read as an ordinary early stop.
export function StatusText({ status }: { status: C5TrainingStatus }) {
  return (
    <span data-c5-status={status} className={status === "stopped_acute" ? "font-semibold text-gray-900" : undefined}>
      {trainingStatusLabel(status)}
    </span>
  );
}

export function Score({ fact, rpe = false }: { fact: ScoreFact; rpe?: boolean }) {
  return (
    <span data-c5-score={fact.kind} className={fact.kind === "value" ? undefined : "italic text-gray-500"}>
      {formatScore(fact, rpe ? formatRpe : (n) => `${n}/10`)}
    </span>
  );
}

export function ImmediateCell({ fact, which }: { fact: C5ImmediateFact; which: "pain" | "rpe" }) {
  if (fact.kind === "none") return <span className="text-gray-400">—</span>;
  if (fact.kind === "pending") return <span className="italic text-gray-500">Check-in pending</span>;
  return <Score fact={which === "pain" ? fact.peakPain : fact.rpe} rpe={which === "rpe"} />;
}

export function MorningCell({ fact }: { fact: MorningFact }) {
  return <span className={fact.kind === "answered" ? undefined : "text-gray-600"}>{morningStatusLabel(fact)}</span>;
}
