import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/components/Logo";
import { CheckCircle2, XCircle, MinusCircle, ArrowLeft } from "lucide-react";
// @ts-ignore
import { BlockMath } from "react-katex";

export const Route = createFileRoute("/student/review/$studentExamId")({ component: ReviewPage });

function MathText({ text }: { text: string }) {
  if (!text) return null;
  const parts = text.split(/(\$\$[^$]+\$\$)/g);
  return (
    <div className="whitespace-pre-wrap leading-relaxed">
      {parts.map((p, i) => {
        if (p.startsWith("$$") && p.endsWith("$$")) {
          try { return <BlockMath key={i} math={p.slice(2, -2)} />; } catch { return <code key={i}>{p}</code>; }
        }
        return <span key={i}>{p}</span>;
      })}
    </div>
  );
}

function ReviewPage() {
  const { studentExamId } = Route.useParams();
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  useEffect(() => { if (!loading && !user) navigate({ to: "/login" }); }, [loading, user, navigate]);

  const { data, isLoading } = useQuery({
    queryKey: ["review", studentExamId],
    queryFn: async () => {
      const { data: se } = await supabase.from("student_exams").select("*, exams(title, id)").eq("id", studentExamId).single();
      if (!se) return null;
      const { data: eq } = await supabase.from("exam_questions").select("question_order, questions(*)").eq("exam_id", se.exam_id).order("question_order");
      const qIds = (eq ?? []).map((r: any) => r.questions?.id).filter(Boolean);
      const { data: ans } = await supabase.from("student_answers").select("*").eq("student_exam_id", studentExamId);
      const { data: sols } = await supabase.from("solutions").select("*").in("question_id", qIds.length ? qIds : ["00000000-0000-0000-0000-000000000000"]);
      const ansMap = new Map((ans ?? []).map((a: any) => [a.question_id, a]));
      const solMap = new Map((sols ?? []).map((s: any) => [s.question_id, s]));
      return { se, items: (eq ?? []).map((r: any) => ({ order: r.question_order, q: r.questions, a: ansMap.get(r.questions?.id), sol: solMap.get(r.questions?.id) })) };
    },
  });

  if (isLoading || !data) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading review…</div>;

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="bg-primary text-primary-foreground">
        <div className="mx-auto max-w-4xl px-6 py-4 flex items-center justify-between">
          <Logo className="text-primary-foreground [&_.text-muted-foreground]:text-primary-foreground/60" />
          <Button asChild variant="secondary" size="sm"><Link to="/student/results/$studentExamId" params={{ studentExamId }}><ArrowLeft className="h-4 w-4 mr-1" />Back to Results</Link></Button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{(data.se as any).exams?.title}</h1>
          <p className="text-sm text-muted-foreground">Question-by-question review with solutions</p>
        </div>

        {data.items.map(({ order, q, a, sol }: any) => {
          if (!q) return null;
          const selected = a?.selected_option ?? "NONE";
          const correct = q.correct_option;
          const isCorrect = selected === correct;
          const isUnattempted = selected === "NONE";
          const status = isUnattempted ? "unattempted" : isCorrect ? "correct" : "wrong";
          return (
            <Card key={q.id} className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-bold uppercase text-muted-foreground">Q{order}</span>
                  {q.topic_tag && <Badge variant="outline">{q.topic_tag}</Badge>}
                  <Badge variant="outline">{q.difficulty}</Badge>
                </div>
                {status === "correct" && <span className="flex items-center gap-1 text-success text-sm font-semibold"><CheckCircle2 className="h-4 w-4" />Correct (+{q.marks})</span>}
                {status === "wrong" && <span className="flex items-center gap-1 text-destructive text-sm font-semibold"><XCircle className="h-4 w-4" />Wrong (−{q.negative_marks})</span>}
                {status === "unattempted" && <span className="flex items-center gap-1 text-muted-foreground text-sm font-semibold"><MinusCircle className="h-4 w-4" />Unattempted</span>}
              </div>

              <MathText text={q.question_text} />
              {q.question_image && <img src={q.question_image} alt="" className="max-h-64 rounded-md border" />}

              <div className="space-y-2">
                {(["A", "B", "C", "D"] as const).map((opt) => {
                  const v = q[`option_${opt.toLowerCase()}`];
                  const img = q[`option_${opt.toLowerCase()}_image`];
                  const isCorrectOpt = correct === opt;
                  const isSelected = selected === opt;
                  let cls = "border";
                  if (isCorrectOpt) cls = "border-success bg-success/10";
                  else if (isSelected) cls = "border-destructive bg-destructive/10";
                  return (
                    <div key={opt} className={`rounded-md ${cls} p-3 text-sm flex gap-2 items-start`}>
                      <span className="font-bold w-5">{opt}.</span>
                      <div className="flex-1">
                        <MathText text={v} />
                        {img && <img src={img} alt="" className="mt-2 max-h-32 rounded border" />}
                      </div>
                      {isCorrectOpt && <Badge className="bg-success text-success-foreground">Correct</Badge>}
                      {isSelected && !isCorrectOpt && <Badge variant="destructive">Your answer</Badge>}
                    </div>
                  );
                })}
              </div>

              {sol?.solution_text && (
                <div className="rounded-md border border-info/30 bg-info/5 p-4">
                  <div className="text-xs font-semibold uppercase text-info mb-2">Solution</div>
                  <MathText text={sol.solution_text} />
                  {sol.solution_image && <img src={sol.solution_image} alt="" className="mt-3 max-h-64 rounded border" />}
                </div>
              )}
            </Card>
          );
        })}
      </main>
    </div>
  );
}
