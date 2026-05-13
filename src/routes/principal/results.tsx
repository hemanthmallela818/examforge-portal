import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { recomputeResults } from "@/lib/results.functions";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/principal/results")({
  component: ResultsAnalytics,
  validateSearch: (s: Record<string, unknown>) => ({ examId: typeof s.examId === "string" ? s.examId : "" }),
});

function ResultsAnalytics() {
  const search = Route.useSearch();
  const [examId, setExamId] = useState<string>(search.examId || "");
  const [recomputing, setRecomputing] = useState(false);
  const recompute = useServerFn(recomputeResults);
  const qc = useQueryClient();

  const { data: exams } = useQuery({
    queryKey: ["res-exams"],
    queryFn: async () => (await supabase.from("exams").select("id, title").order("created_at", { ascending: false })).data ?? [],
  });

  useEffect(() => { if (!examId && exams?.[0]) setExamId(exams[0].id); }, [exams, examId]);

  const { data: rows } = useQuery({
    queryKey: ["res-rows", examId],
    enabled: !!examId,
    queryFn: async () => {
      const { data } = await supabase.from("student_exams")
        .select("id, student_id, status, total_score, submitted_at, profiles!inner(full_name, email), exam_results(total_correct, total_wrong, total_unattempted, rank, percentile)")
        .eq("exam_id", examId)
        .in("status", ["SUBMITTED", "TERMINATED"])
        .order("total_score", { ascending: false, nullsFirst: false });
      return data ?? [];
    },
  });

  const stats = useMemo(() => {
    if (!rows?.length) return null;
    const scores = rows.map((r: any) => Number(r.total_score ?? 0));
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const max = Math.max(...scores); const min = Math.min(...scores);
    return { avg, max, min, n: rows.length };
  }, [rows]);

  async function onRecompute() {
    if (!examId) return;
    setRecomputing(true);
    try {
      const r = await recompute({ data: { examId } });
      toast.success(`Recomputed ${r.updated} results`);
      qc.invalidateQueries({ queryKey: ["res-rows", examId] });
    } catch (e: any) {
      toast.error(e?.message ?? "Recompute failed");
    } finally { setRecomputing(false); }
  }

  return (
    <PrincipalShell>
      <header className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Results & Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">Leaderboard with rank, percentile and subject breakdown</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={examId} onChange={(e) => setExamId(e.target.value)} className="border rounded-md px-3 py-2 text-sm bg-background">
            <option value="">Select exam…</option>
            {exams?.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
          </select>
          <Button onClick={onRecompute} disabled={!examId || recomputing} variant="outline" size="sm">
            {recomputing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Recompute
          </Button>
        </div>
      </header>

      {stats && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          <Stat k="Submissions" v={String(stats.n)} />
          <Stat k="Average" v={stats.avg.toFixed(2)} />
          <Stat k="Highest" v={stats.max.toFixed(2)} />
          <Stat k="Lowest" v={stats.min.toFixed(2)} />
        </div>
      )}

      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Rank</th>
              <th className="px-4 py-3">Student</th>
              <th className="px-4 py-3">Correct</th>
              <th className="px-4 py-3">Wrong</th>
              <th className="px-4 py-3">Unatt.</th>
              <th className="px-4 py-3 text-right">%ile</th>
              <th className="px-4 py-3 text-right">Score</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows?.map((r: any, i: number) => {
              const er = r.exam_results?.[0];
              return (
                <tr key={r.id}>
                  <td className="px-4 py-3 font-semibold">{er?.rank ?? i + 1}</td>
                  <td className="px-4 py-3"><div className="font-medium">{r.profiles?.full_name}</div><div className="text-xs text-muted-foreground">{r.profiles?.email}</div></td>
                  <td className="px-4 py-3 text-success">{er?.total_correct ?? "—"}</td>
                  <td className="px-4 py-3 text-destructive">{er?.total_wrong ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{er?.total_unattempted ?? "—"}</td>
                  <td className="px-4 py-3 text-right">{er?.percentile != null ? `${Number(er.percentile).toFixed(1)}` : "—"}</td>
                  <td className="px-4 py-3 text-right font-bold">{Number(r.total_score ?? 0).toFixed(2)}</td>
                </tr>
              );
            })}
            {rows && !rows.length && examId && <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No submissions yet for this exam.</td></tr>}
          </tbody>
        </table>
      </Card>
    </PrincipalShell>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return <Card className="p-4"><div className="text-xs text-muted-foreground">{k}</div><div className="text-2xl font-bold mt-1">{v}</div></Card>;
}
