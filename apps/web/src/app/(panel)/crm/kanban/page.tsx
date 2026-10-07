"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { createClient } from "@/lib/supabase";

interface Lead {
  id: string;
  full_name: string;
  phone: string;
  status: "new" | "contacted" | "interested" | "qualified" | "converted" | "lost";
  source: string;
  assigned_to: string | null;
  created_at: string;
}

interface KanbanColumn {
  status: string;
  label: string;
  leads: Lead[];
  color: string;
}

export default function CRMKanbanPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const supabase = createClient();

  const [columns, setColumns] = useState<KanbanColumn[]>([
    { status: "new", label: "Yeni", leads: [], color: "bg-gray-100" },
    { status: "contacted", label: "İletişime Geçildi", leads: [], color: "bg-blue-100" },
    { status: "interested", label: "İlgilendiği", leads: [], color: "bg-yellow-100" },
    { status: "qualified", label: "Nitelikli", leads: [], color: "bg-green-100" },
    { status: "converted", label: "Müşteri", leads: [], color: "bg-emerald-100" },
    { status: "lost", label: "Kaybedildi", leads: [], color: "bg-red-100" },
  ]);

  const [loading, setLoading] = useState(true);
  const [draggedLead, setDraggedLead] = useState<{ lead: Lead; fromStatus: string } | null>(null);

  useEffect(() => {
    if (!user?.clinic_id) return;
    fetchLeads();
  }, [user?.clinic_id]);

  const fetchLeads = async () => {
    try {
      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .eq("clinic_id", user?.clinic_id)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const leads = data || [];

      // Organize leads by status
      const updatedColumns = columns.map((col) => ({
        ...col,
        leads: leads.filter((lead) => lead.status === col.status),
      }));

      setColumns(updatedColumns);
    } catch (error) {
      console.error("Error fetching leads:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDragStart = (lead: Lead, status: string) => {
    setDraggedLead({ lead, fromStatus: status });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (toStatus: string) => {
    if (!draggedLead) return;

    const { lead, fromStatus } = draggedLead;

    // Prevent dropping on same column
    if (fromStatus === toStatus) {
      setDraggedLead(null);
      return;
    }

    try {
      // Update lead status in database
      const { error } = await supabase
        .from("leads")
        .update({ status: toStatus })
        .eq("id", lead.id)
        .eq("clinic_id", user?.clinic_id);

      if (error) throw error;

      // Update UI
      const updatedColumns = columns.map((col) => {
        if (col.status === fromStatus) {
          return {
            ...col,
            leads: col.leads.filter((l) => l.id !== lead.id),
          };
        }
        if (col.status === toStatus) {
          return {
            ...col,
            leads: [...col.leads, { ...lead, status: toStatus as any }],
          };
        }
        return col;
      });

      setColumns(updatedColumns);
      setDraggedLead(null);
    } catch (error) {
      console.error("Error updating lead status:", error);
    }
  };

  const getSourceBadge = (source: string) => {
    const colors: Record<string, string> = {
      direct: "bg-blue-200 text-blue-800",
      referral: "bg-purple-200 text-purple-800",
      online: "bg-green-200 text-green-800",
      social_media: "bg-pink-200 text-pink-800",
      other: "bg-gray-200 text-gray-800",
    };
    const labels: Record<string, string> = {
      direct: "Doğrudan",
      referral: "Tavsiye",
      online: "Online",
      social_media: "Sosyal",
      other: "Diğer",
    };
    return (
      <span className={`px-2 py-1 rounded text-xs font-semibold ${colors[source] || colors.other}`}>
        {labels[source] || source}
      </span>
    );
  };

  if (loading) {
    return <div className="p-8">Yükleniyor...</div>;
  }

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">CRM - Kanban Tahtası</h1>
        <button
          onClick={() => router.push("/crm/new-lead")}
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Yeni Lead
        </button>
      </div>

      {/* Kanban Board */}
      <div className="grid grid-cols-6 gap-4 auto-cols-max">
        {columns.map((column) => (
          <div
            key={column.status}
            className={`${column.color} rounded-lg p-4 min-w-80 min-h-96`}
            onDragOver={handleDragOver}
            onDrop={() => handleDrop(column.status)}
          >
            <div className="mb-4">
              <h2 className="text-lg font-bold text-gray-800">{column.label}</h2>
              <div className="text-sm text-gray-600">
                {column.leads.length} lead{column.leads.length !== 1 ? "s" : ""}
              </div>
            </div>

            <div className="space-y-3">
              {column.leads.map((lead) => (
                <div
                  key={lead.id}
                  draggable
                  onDragStart={() => handleDragStart(lead, column.status)}
                  onClick={() => router.push(`/crm/leads/${lead.id}`)}
                  className="bg-white rounded-lg p-4 shadow cursor-move hover:shadow-lg transition-shadow"
                >
                  <div className="mb-2">
                    <h3 className="font-semibold text-gray-800 text-sm">
                      {lead.full_name}
                    </h3>
                    <p className="text-xs text-gray-500">{lead.phone}</p>
                  </div>
                  <div className="flex justify-between items-center">
                    {getSourceBadge(lead.source)}
                    <span className="text-xs text-gray-500">
                      {new Date(lead.created_at).toLocaleDateString("tr-TR")}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Summary */}
      <div className="mt-8 grid grid-cols-6 gap-4">
        {columns.map((column) => (
          <div key={column.status} className="bg-white rounded-lg shadow p-4 text-center">
            <div className="text-2xl font-bold text-gray-800">
              {column.leads.length}
            </div>
            <div className="text-sm text-gray-600">{column.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
