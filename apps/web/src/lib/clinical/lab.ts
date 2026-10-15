// Lab job rules shared with the server (spec p9_clinical §1.5). The server answers `allowed_next`; this copy is
// for tests and for the status dialog's labels only.

import { daysBetween } from "./dates";
import { LAB_STATUS_LABELS, type LabStatus } from "./codes";

/** §1.5 matrix: exactly 21 allowed pairs. */
export const LAB_TRANSITIONS: Record<LabStatus, readonly LabStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["in_progress", "try_in", "ready", "cancelled"],
  in_progress: ["try_in", "ready", "cancelled"],
  try_in: ["revision", "ready", "delivered", "cancelled"],
  revision: ["in_progress", "try_in", "ready", "cancelled"],
  ready: ["revision", "delivered", "cancelled"],
  delivered: ["ready"],
  cancelled: [],
};

export function labTransitionOk(from: LabStatus | string, to: LabStatus | string): boolean {
  const next = LAB_TRANSITIONS[from as LabStatus];
  return !!next && from !== to && next.includes(to as LabStatus);
}

/** Statuses during which the work is out at the lab (late can apply). `draft` is never late (not sent). */
export const LAB_OUT_STATUSES: readonly LabStatus[] = ["submitted", "in_progress", "try_in", "revision"];

/** CW:32 mapped: out at the lab and the expected return day is before today. Due today is not late. */
export function isLabLate(status: LabStatus | string, due: string | null | undefined, today: string): boolean {
  if (!due || !(LAB_OUT_STATUSES as readonly string[]).includes(status)) return false;
  return due < today;
}

export function daysLate(due: string, today: string): number {
  return daysBetween(due, today);
}

/** Label of the date field in the status dialog, by target status (§7.6). */
export function statusDateLabel(to: LabStatus | string, from?: LabStatus | string): string {
  switch (to) {
    case "submitted":
      return "Gönderim tarihi";
    case "try_in":
      return "Prova tarihi";
    case "revision":
      return "Revizyona gönderim tarihi";
    case "ready":
      return from === "delivered" ? "Tarih" : "Kliniğe geliş tarihi";
    case "delivered":
      return "Hastaya teslim tarihi";
    case "cancelled":
      return "İptal tarihi";
    default:
      return "Tarih";
  }
}

/** Button text for a transition; delivered → ready is the "Teslimi geri al" undo. */
export function transitionLabel(from: LabStatus | string, to: LabStatus): string {
  if (from === "delivered" && to === "ready") return "Teslimi geri al";
  if (to === "submitted") return "Laboratuvara gönderildi";
  if (to === "cancelled") return "İptal et";
  return LAB_STATUS_LABELS[to];
}
