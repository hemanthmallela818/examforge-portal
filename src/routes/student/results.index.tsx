import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useEffect } from "react";
import { ArrowLeft, Trophy } from "lucide-react";

export const Route = createFileRoute("/student/results/")({ component: ResultsHistory });

function ResultsHistory() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  useEffect(() => { if (!loading && !user) navigate({ to: "/login" }); }, [loading, user, navigate]);

  const { data: rows, isLoading } = useQuery({
    queryKey: ["student-results-history", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("student_exams")
        .select("id, status, total_score, submitted_at, started_at, exams(title, marks_per_correct)")
        .eq("student_id", user!.id)
        .in("status", ["SUBMITTED", "TERMINATED"])
        .order("submitted_at", { ascending: false });
      return data ?? [];
    },
  });

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="bg-primary text-primary-foreground">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between">
          <Logo className="text-primary-foreground [&_.text-muted-foreground]:text-primary-foreground/60" />
          <Button asChild variant="secondary" size="sm"><Link to="/student"><ArrowLeft className="h-4 w-4 mr-1" /> Dashboard</Link></Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex items-center gap-2 mb-6">
          <Trophy className="h-5 w-5 text-warning" />
          <h1 className="text-2xl font-bold">Previous Exam Results</h1>
        </div>

        {isLoading ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">Loading…</Card>
        ) : rows && rows.length > 0 ? (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-3">Exam</th>
                  <th className="text-left px-4 py-3">Submitted</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-right px-4 py-3">Score</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r: any) => (
                  <tr key={r.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{r.exams?.title ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{r.submitted_at ? new Date(r.submitted_at).toLocaleString() : "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs rounded-full px-2 py-0.5 ${r.status === "SUBMITTED" ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}`}>{r.status}</span>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{Number(r.total_score ?? 0).toFixed(2)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button asChild size="sm" variant="outline"><Link to="/student/results/$studentExamId" params={{ studentExamId: r.id }}>View</Link></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : (
          <Card className="p-10 text-center text-sm text-muted-foreground">You haven't completed any exams yet.</Card>
        )}
      </main>
    </div>
  );
}
