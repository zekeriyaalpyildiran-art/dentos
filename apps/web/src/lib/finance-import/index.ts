// Finance import library (Phase 2 + Phase 4 parsers). Pure modules plus read-file.ts, which loads
// SheetJS and pdf.js lazily (dynamic import) so the heavy libraries stay in the import screens' chunks.
// Spec: p2i_parsers_rules.md; database contract: p2i_db_contract.md.

export * from "./types";
export * from "./primitives";
export * from "./keys";
export * from "./classify";
export * from "./layout";
export * from "./workbook";
export * from "./bank-text";
export * from "./bank-xlsx";
export * from "./bank-table";
export * from "./financing";
export * from "./balances";
export * from "./matching";
export * from "./review";
export * from "./detect";
export * from "./read-file";
