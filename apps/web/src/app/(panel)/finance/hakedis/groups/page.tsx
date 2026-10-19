"use client";

import { FinanceShell } from "@/components/finance/FinanceShell";
import { HakedisGroupsView } from "@/components/finance/HakedisMacroParts";

/** Finans → Hakediş · İşlem grupları: procedure groups and the Macro doctor mapping (0033). */
export default function FinanceHakedisGroupsPage() {
  return (
    <FinanceShell title="İşlem grupları ve Macro hekimleri">
      <HakedisGroupsView mode="finance" />
    </FinanceShell>
  );
}
