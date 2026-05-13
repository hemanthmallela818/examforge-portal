import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { Plus, Play, CheckCircle2, FileText, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/principal/exams")({ component: ExamsList });

function ExamsList() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: exams, isLoading } = useQuery({
    queryKey: ["exams-list"],
    queryFn: async () => {
      const { data } = await supabase
        .from("exams")
        .select("id, title, status, scheduled_date, start_time, duration_minutes, created_at")
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  async function setStatus(id: string, status: "DRAFT" | "SCHEDULED" | "ONGOING" | "COMPLETED") {
    const { error } = await supabase.from("exams").update({ status }).eq("id", id);
    if (error) return toast.error(error.message);
    toast.success(`Exam marked ${status}`);
    qc.invalidateQueries({ queryKey: ["exams-list"] });
  }

  async function remove(id: string) {
    if (!confirm("Delete this exam? Student attempts will remain in records.")) return;
    await supabase.from("exam_questions").delete().eq("exam_id", id);
    await supabase.from("exam_subjects").delete().eq("exam_id", id);
    await supabase.from("exam_assignments").delete().eq("exam_id", id);
    const { error } = await supabase.from("exams").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Exam deleted");
    qc.invalidateQueries({ queryKey: ["exams-list"] });
  }

  return (
    <PrincipalShell>
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Exams</h1>
          <p className="text-sm text-muted-foreground mt-1">Create, schedule, and monitor mock exams</p>
        </div>
        <Button asChild><Link to="/principal/exams/new"><Plus className="h-4 w-4 mr-1" /> New Exam</Link></Button>
      </header>

      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Schedule</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>}
            {exams?.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-3 font-medium">{e.title}</td>
                <td className="px-4 py-3 text-muted-foreground">{e.scheduled_date ?? "—"} {e.start_time ?? ""}</td>
                <td className="px-4 py-3">{e.duration_minutes} min</td>
                <td className="px-4 py-3">
                  <span className={`text-xs rounded-full px-2 py-0.5 ${
                    e.status === "ONGOING" ? "bg-success/15 text-success" :
                    e.status === "COMPLETED" ? "bg-muted text-muted-foreground" :
                    e.status === "SCHEDULED" ? "bg-info/15 text-info" :
                    "bg-warning/15 text-warning"
                  }`}>{e.status}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    {e.status === "DRAFT" && <Button size="sm" variant="outline" onClick={() => setStatus(e.id, "SCHEDULED")}><FileText className="h-3.5 w-3.5 mr-1" /> Schedule</Button>}
                    {(e.status === "SCHEDULED" || e.status === "DRAFT") && <Button size="sm" onClick={() => setStatus(e.id, "ONGOING")}><Play className="h-3.5 w-3.5 mr-1" /> Start</Button>}
                    {e.status === "ONGOING" && <Button size="sm" variant="outline" onClick={() => setStatus(e.id, "COMPLETED")}><CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Complete</Button>}
                    <Button size="sm" variant="ghost" onClick={() => navigate({ to: "/principal/results", search: { examId: e.id } as any })}>Results</Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(e.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </td>
              </tr>
            ))}
            {exams && exams.length === 0 && !isLoading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No exams yet. Click "New Exam" to start.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </PrincipalShell>
  );
}
