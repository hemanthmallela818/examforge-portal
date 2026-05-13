import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { Activity } from "lucide-react";

export const Route = createFileRoute("/principal/monitor")({ component: Monitor });

function Monitor() {
  const [examId, setExamId] = useState<string>("");

  const { data: exams } = useQuery({
    queryKey: ["mon-exams"],
    queryFn: async () => (await supabase.from("exams").select("id, title, status").eq("status", "ONGOING").order("created_at", { ascending: false })).data ?? [],
  });

  useEffect(() => { if (!examId && exams?.[0]) setExamId(exams[0].id); }, [exams, examId]);

  const { data: live, refetch } = useQuery({
    queryKey: ["mon-live", examId],
    enabled: !!examId,
    queryFn: async () => {
      const { data: ses } = await supabase.from("student_exams")
        .select("id, student_id, status, started_at, submitted_at, total_score, profiles!inner(full_name, email)")
        .eq("exam_id", examId);
      return ses ?? [];
    },
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (!examId) return;
    const ch = supabase.channel(`monitor-${examId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "student_exams", filter: `exam_id=eq.${examId}` }, () => refetch())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [examId, refetch]);

  return (
    <PrincipalShell>
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2"><Activity className="h-6 w-6 text-success" /> Live Monitor</h1>
          <p className="text-sm text-muted-foreground mt-1">Real-time view of ongoing exams</p>
        </div>
        <select value={examId} onChange={(e) => setExamId(e.target.value)} className="border rounded-md px-3 py-2 text-sm bg-background">
          <option value="">Select exam…</option>
          {exams?.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select>
      </header>

      {!examId ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">No ongoing exams. Start one from the Exams page.</Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-4 py-3">Student</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Started</th><th className="px-4 py-3">Submitted</th><th className="px-4 py-3 text-right">Score</th></tr>
            </thead>
            <tbody className="divide-y">
              {live?.map((s: any) => (
                <tr key={s.id}>
                  <td className="px-4 py-3"><div className="font-medium">{s.profiles?.full_name}</div><div className="text-xs text-muted-foreground">{s.profiles?.email}</div></td>
                  <td className="px-4 py-3">
                    <span className={`text-xs rounded-full px-2 py-0.5 ${
                      s.status === "ONGOING" ? "bg-success/15 text-success" :
                      s.status === "SUBMITTED" ? "bg-info/15 text-info" :
                      s.status === "TERMINATED" ? "bg-destructive/15 text-destructive" :
                      "bg-muted text-muted-foreground"
                    }`}>{s.status}</span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{s.started_at ? new Date(s.started_at).toLocaleTimeString() : "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{s.submitted_at ? new Date(s.submitted_at).toLocaleTimeString() : "—"}</td>
                  <td className="px-4 py-3 text-right font-semibold">{s.total_score != null ? Number(s.total_score).toFixed(2) : "—"}</td>
                </tr>
              ))}
              {live && live.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No student attempts yet.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </PrincipalShell>
  );
}
