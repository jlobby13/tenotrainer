// PEC — pure formatting of "Last time" (factual context only; no
// comparison, no advice). Never implies one load applied to every set:
// if any recorded load or load unit differs between sets, each set is
// listed with its own load.
import type { C5LastTime } from "@/lib/c5RuntimeTypes";
import { formatValue } from "./c5Display";

function suffix(lt: C5LastTime): string {
  if (lt.field === "duration") return "sec";
  if (lt.field === "distance") return lt.distanceUnit ?? "m";
  return lt.field === "contacts" ? "contacts" : "reps";
}

export function lastTimeDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function describeLastTime(lt: C5LastTime): string {
  const unit = suffix(lt);
  const value = (v: number | null) => (v == null ? "done" : formatValue(v));
  const loads = lt.units.map((u) => (u.load == null ? "none" : `${formatValue(u.load)} ${u.loadUnit ?? ""}`.trim()));
  const sameLoad = loads.every((l) => l === loads[0]);
  if (sameLoad) {
    const values = lt.units.map((u) => value(u.value)).join(" · ");
    return loads[0] === "none" ? `${values} ${unit}` : `${values} ${unit} at ${loads[0]}`;
  }
  return lt.units.map((u, i) => `${value(u.value)} ${unit}${loads[i] === "none" ? "" : ` at ${loads[i]}`}`).join(" · ");
}
