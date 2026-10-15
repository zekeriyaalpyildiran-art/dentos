"use client";

import { useCallback, useEffect, useState } from "react";
import { finImportSetup, toFinanceError, type FinanceError, type ImportSetupJson } from "@/lib/finance";

/** Loads fin_import_setup (settings, accounts with import keys, classification rules, saved layouts). */
export function useImportSetup() {
  const [data, setData] = useState<ImportSetupJson | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await finImportSetup();
      setData(next);
      setError(null);
      return next;
    } catch (err) {
      setError(toFinanceError(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload };
}
