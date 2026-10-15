// Server-side patient search (name as a case-insensitive regex, phone with ilike, plus the digits of the phone against
// patients.phone_normalized from 0021). Shared by the patient list and PatientPicker. Pure helpers, unit-tested.

/** PostgREST `or` filter values must not carry its syntax characters. */
export function safeSearchTerm(q: string): string {
  return q.replace(/[,()*%\\:."']/g, " ").replace(/\s+/g, " ").trim();
}

/** Every Turkish i: dotted and dotless, lower and upper case. */
const TURKISH_I_CLASS = "[iıİI]";

/**
 * Name pattern for PostgREST `imatch` (Postgres `~*`), or null when nothing searchable is left.
 * Postgres lower() / ILIKE fold "I" to "i" and leave "ı" alone, so "yılmaz" never matched "YILMAZ" and "ırmak" never
 * matched "Irmak" with ilike. Here every i, ı, İ, I of the term matches any of the four. Letters, digits, spaces and
 * "-" are kept as typed (none is a regex operator outside a bracket); every other character (no patient name carries
 * one) is dropped, so the term can never act as a regex operator or start a PostgREST array value.
 */
export function nameSearchPattern(term: string): string | null {
  const kept = term
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!kept) return null;
  return kept.replace(/[iıİI]/g, TURKISH_I_CLASS);
}

/**
 * Value for `.or(...)`, or null when the cleaned term is shorter than `minLength`. A term with at least 3 digits also
 * matches phone_normalized (digits only, 90... form), so "0532 123" finds "+90 532 123 45 67".
 */
export function patientSearchFilter(q: string, minLength = 1): string | null {
  const term = safeSearchTerm(q);
  if (term.length < Math.max(1, minLength)) return null;
  const parts: string[] = [];
  const name = nameSearchPattern(term);
  if (name) parts.push(`full_name.imatch.${name}`);
  parts.push(`phone.ilike.*${term}*`);
  const digits = term.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length >= 3) parts.push(`phone_normalized.ilike.*${digits}*`);
  return parts.join(",");
}
