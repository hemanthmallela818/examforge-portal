import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useEffect } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/student/exam/$examId")({ component: ExamInstructions });

function ExamInstructions() {
  const { examId } = Route.useParams();
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => { if (!loading && !user) navigate({ to: "/login" }); }, [loading, user, navigate]);

  const { data: exam } = useQuery({
    queryKey: ["exam-info", examId],
    queryFn: async () => (await supabase.from("exams").select("*").eq("id", examId).maybeSingle()).data,
  });

  const { data: count } = useQuery({
    queryKey: ["exam-qcount", examId],
    queryFn: async () => (await supabase.from("exam_questions").select("id", { count: "exact", head: true }).eq("exam_id", examId)).count ?? 0,
  });

  async function start() {
    if (!user || !exam) return;
    if (exam.status !== "ONGOING" && exam.status !== "SCHEDULED") {
      toast.error("This exam is not active.");
      return;
    }
    // Best-effort fullscreen — never block exam start (fails in preview iframes)
    try { await document.documentElement.requestFullscreen?.(); } catch {}

    try {
      const { data: existing, error: selErr } = await supabase
        .from("student_exams").select("id, status").eq("student_id", user.id).eq("exam_id", examId).maybeSingle();
      if (selErr) { toast.error(selErr.message); return; }

      if (!existing) {
        const { error: insErr } = await supabase.from("student_exams").insert({
          student_id: user.id, exam_id: examId, status: "ONGOING", started_at: new Date().toISOString(),
        });
        if (insErr) { toast.error(insErr.message); return; }
      } else if (existing.status === "SUBMITTED" || existing.status === "TERMINATED") {
        navigate({ to: "/student/results/$studentExamId", params: { studentExamId: existing.id } });
        return;
      } else if (existing.status === "NOT_STARTED") {
        await supabase.from("student_exams").update({ status: "ONGOING", started_at: new Date().toISOString() }).eq("id", existing.id);
      }
      navigate({ to: "/student/exam/$examId/attempt", params: { examId } });
    } catch (e: any) {
      toast.error(e?.message ?? "Could not start exam");
    }
  }

  if (!exam) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>;

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="bg-primary text-primary-foreground">
        <div className="mx-auto max-w-4xl px-6 py-4"><Logo className="text-primary-foreground [&_.text-muted-foreground]:text-primary-foreground/60" /></div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-10">
        <Card className="p-8">
          <h1 className="text-2xl font-bold">{exam.title}</h1>
          {exam.description && <p className="text-muted-foreground mt-2">{exam.description}</p>}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
            <Stat k="Questions" v={String(count ?? "…")} />
            <Stat k="Duration" v={`${exam.duration_minutes} min`} />
            <Stat k="Marking" v={`+${exam.marks_per_correct} / -${(exam.marks_per_correct * Number(exam.negative_marking_ratio)).toFixed(2)}`} />
            <Stat k="Status" v={exam.status} />
          </div>

          <h2 className="font-semibold mt-8 mb-2">Instructions</h2>
          <pre className="whitespace-pre-wrap text-sm bg-muted rounded-md p-4 font-sans">{exam.instructions ?? "Read each question carefully and choose the best answer."}</pre>

          <div className="mt-6 rounded-md border-l-4 border-warning bg-warning/10 p-4 text-sm">
            <strong>Lockdown notice:</strong> The exam will run in fullscreen. Switching tabs, exiting fullscreen, or copying content will be logged and may auto-terminate your attempt.
          </div>

          <div className="mt-8 flex justify-between">
            <Button variant="ghost" onClick={() => navigate({ to: "/student" })}>Back</Button>
            <Button size="lg" onClick={start}>I'm ready — Start Exam</Button>
          </div>
        </Card>
      </main>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return <div className="rounded-md border bg-background px-4 py-3"><div className="text-xs text-muted-foreground">{k}</div><div className="font-semibold mt-0.5">{v}</div></div>;
}
