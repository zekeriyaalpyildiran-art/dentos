// Server-side patient search (ilike on name / phone, plus the digits of the phone against patients.phone_normalized
// from 0021). Shared by the patient list and PatientPicker. Pure helpers, unit-tested.

/** PostgREST `or` filter values must not carry its syntax characters. */
export function safeSearchTerm(q: string): string {
  return q.replace(/[,()*%\\:."']/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Value for `.or(...)`, or null when the cleaned term is shorter than `minLength`. A term with at least 3 digits also
 * matches phone_normalized (digits only, 90... form), so "0532 123" finds "+90 532 123 45 67".
 */
export function patientSearchFilter(q: string, minLength = 1): string | null {
  const term = safeSearchTerm(q);
  if (term.length < Math.max(1, minLength)) return null;
  const parts = [`full_name.ilike.*${term}*`, `phone.ilike.*${term}*`];
  const digits = term.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length >= 3) parts.push(`phone_normalized.ilike.*${digits}*`);
  return parts.join(",");
}
