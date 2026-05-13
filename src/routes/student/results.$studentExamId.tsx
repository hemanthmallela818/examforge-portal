import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useEffect } from "react";
import { CheckCircle2, XCircle, MinusCircle, Trophy } from "lucide-react";

export const Route = createFileRoute("/student/results/$studentExamId")({ component: ResultsPage });

function ResultsPage() {
  const { studentExamId } = Route.useParams();
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  useEffect(() => { if (!loading && !user) navigate({ to: "/login" }); }, [loading, user, navigate]);

  const { data } = useQuery({
    queryKey: ["sresult", studentExamId],
    queryFn: async () => {
      const { data: se } = await supabase.from("student_exams")
        .select("*, exams(title, marks_per_correct, negative_marking_ratio)").eq("id", studentExamId).single();
      const { data: r } = await supabase.from("exam_results").select("*").eq("student_exam_id", studentExamId).maybeSingle();
      return { se, r };
    },
  });

  if (!data?.se) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>;
  const se: any = data.se; const r: any = data.r;
  const total = (r?.total_correct ?? 0) + (r?.total_wrong ?? 0) + (r?.total_unattempted ?? 0);
  const subjScores = (r?.subject_wise_scores ?? {}) as Record<string, { correct: number; wrong: number; score: number }>;

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="bg-primary text-primary-foreground">
        <div className="mx-auto max-w-4xl px-6 py-4"><Logo className="text-primary-foreground [&_.text-muted-foreground]:text-primary-foreground/60" /></div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-10 space-y-6">
        <Card className="p-8 text-center">
          <Trophy className="h-10 w-10 text-warning mx-auto" />
          <h1 className="text-2xl font-bold mt-3">{se.exams?.title}</h1>
          <p className="text-muted-foreground text-sm mt-1">{se.status === "TERMINATED" ? `Auto-terminated: ${se.termination_reason}` : "Submitted successfully"}</p>
          <div className="mt-6 text-5xl font-bold">{Number(se.total_score ?? 0).toFixed(2)}</div>
          <div className="text-xs text-muted-foreground mt-1">Total Score</div>
        </Card>

        <div className="grid grid-cols-3 gap-4">
          <Tile icon={<CheckCircle2 className="text-success" />} n={r?.total_correct ?? 0} l="Correct" />
          <Tile icon={<XCircle className="text-destructive" />} n={r?.total_wrong ?? 0} l="Wrong" />
          <Tile icon={<MinusCircle className="text-muted-foreground" />} n={r?.total_unattempted ?? 0} l="Unattempted" />
        </div>

        {Object.keys(subjScores).length > 0 && (
          <Card className="p-6">
            <h2 className="font-semibold mb-3">Subject-wise breakdown</h2>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground"><tr><th className="text-left py-2">Subject</th><th>Correct</th><th>Wrong</th><th className="text-right">Score</th></tr></thead>
              <tbody className="divide-y">
                {Object.entries(subjScores).map(([s, v]) => (
                  <tr key={s}><td className="py-2 font-medium">{s}</td><td className="text-center text-success">{v.correct}</td><td className="text-center text-destructive">{v.wrong}</td><td className="text-right font-semibold">{Number(v.score).toFixed(2)}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        <div className="text-center text-xs text-muted-foreground">Attempted {total} questions</div>
        <div className="flex justify-center"><Button asChild><Link to="/student">Back to Dashboard</Link></Button></div>
      </main>
    </div>
  );
}

function Tile({ icon, n, l }: { icon: React.ReactNode; n: number; l: string }) {
  return <Card className="p-5 text-center"><div className="flex justify-center">{icon}</div><div className="text-3xl font-bold mt-2">{n}</div><div className="text-xs text-muted-foreground">{l}</div></Card>;
}
