"use client";

import { useCallback, useEffect, useState } from "react";
import { finReferenceData, toFinanceError, type FinanceError, type ReferenceData } from "@/lib/finance";

/** Loads fin_reference_data (settings, accounts, groups, categories, counterparties, doctors). */
export function useReferenceData() {
  const [data, setData] = useState<ReferenceData | null>(null);
  const [error, setError] = useState<FinanceError | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await finReferenceData();
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
