// FDI tooth numbers (spec p9_clinical §1.5). Permanent teeth only: legacy has no primary-teeth rule (CR:25),
// so 51-85 are refused exactly as the server's CHECK refuses them.

/** 11-18, 21-28, 31-38, 41-48. */
export function isPermanentFdi(n: number): boolean {
  if (!Number.isInteger(n)) return false;
  const quadrant = Math.trunc(n / 10);
  const tooth = n % 10;
  return quadrant >= 1 && quadrant <= 4 && tooth >= 1 && tooth <= 8;
}

/** Trimmed text of exactly two digits that is a permanent FDI tooth; anything else → null. */
export function parseFdi(s: string): number | null {
  const t = (s ?? "").trim();
  if (!/^\d{2}$/.test(t)) return null;
  const n = Number(t);
  return isPermanentFdi(n) ? n : null;
}

/**
 * Display order in the dentist's view: upper jaw 18…11 | 21…28, lower jaw 48…41 | 31…38.
 * Each row is [patient's right half, patient's left half].
 */
export const FDI_ROWS: readonly (readonly [readonly number[], readonly number[]])[] = [
  [
    [18, 17, 16, 15, 14, 13, 12, 11],
    [21, 22, 23, 24, 25, 26, 27, 28],
  ],
  [
    [48, 47, 46, 45, 44, 43, 42, 41],
    [31, 32, 33, 34, 35, 36, 37, 38],
  ],
];

export const ALL_PERMANENT_FDI: readonly number[] = [1, 2, 3, 4].flatMap((q) =>
  [1, 2, 3, 4, 5, 6, 7, 8].map((t) => q * 10 + t)
);
