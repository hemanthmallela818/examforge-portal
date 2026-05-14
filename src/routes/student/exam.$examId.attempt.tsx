import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { Flag, ChevronLeft, ChevronRight, Send, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/student/exam/$examId/attempt")({ component: ExamAttempt });

type Letter = "A" | "B" | "C" | "D" | "NONE";

function ExamAttempt() {
  const { examId } = Route.useParams();
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  const [studentExamId, setStudentExamId] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Letter>>({});
  const [marked, setMarked] = useState<Record<string, boolean>>({});
  const [visited, setVisited] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [violations, setViolations] = useState(0);
  const submittedRef = useRef(false);

  useEffect(() => { if (!loading && !user) navigate({ to: "/login" }); }, [loading, user, navigate]);

  const { data: exam } = useQuery({
    queryKey: ["att-exam", examId],
    queryFn: async () => (await supabase.from("exams").select("*").eq("id", examId).single()).data,
  });

  const { data: questions } = useQuery({
    queryKey: ["att-questions", examId],
    queryFn: async () => {
      const { data } = await supabase
        .from("exam_questions")
        .select("question_order, questions(id, question_text, option_a, option_b, option_c, option_d, subject_id, subjects(name))")
        .eq("exam_id", examId)
        .order("question_order");
      return (data ?? []).map((r: any) => ({ ...r.questions, order: r.question_order }));
    },
  });

  // Bootstrap student_exam + load saved answers
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: se } = await supabase.from("student_exams")
        .select("id, started_at, status").eq("student_id", user.id).eq("exam_id", examId).maybeSingle();
      if (!se) { navigate({ to: "/student/exam/$examId", params: { examId } }); return; }
      if (se.status === "SUBMITTED" || se.status === "TERMINATED") {
        navigate({ to: "/student/results/$studentExamId", params: { studentExamId: se.id } }); return;
      }
      setStudentExamId(se.id);
      const { data: ans } = await supabase.from("student_answers")
        .select("question_id, selected_option, is_marked_for_review").eq("student_exam_id", se.id);
      const a: Record<string, Letter> = {}; const m: Record<string, boolean> = {};
      (ans ?? []).forEach((r) => { a[r.question_id] = r.selected_option as Letter; m[r.question_id] = r.is_marked_for_review; });
      setAnswers(a); setMarked(m);
    })();
  }, [user, examId, navigate]);

  // Timer
  useEffect(() => {
    if (!exam || !studentExamId) return;
    (async () => {
      const { data: se } = await supabase.from("student_exams").select("started_at").eq("id", studentExamId).single();
      const startedAt = se?.started_at ? new Date(se.started_at).getTime() : Date.now();
      const endAt = startedAt + exam.duration_minutes * 60 * 1000;
      const tick = () => setSecondsLeft(Math.max(0, Math.floor((endAt - Date.now()) / 1000)));
      tick();
      const i = setInterval(tick, 1000);
      return () => clearInterval(i);
    })();
  }, [exam, studentExamId]);

  const submit = useCallback(async (reason?: string) => {
    if (submittedRef.current || !studentExamId || !exam || !questions) return;
    submittedRef.current = true;
    setSubmitting(true);

    let correct = 0, wrong = 0, unattempted = 0;
    const subjScores: Record<string, { correct: number; wrong: number; score: number }> = {};
    // fetch correct options
    const ids = questions.map((q: any) => q.id);
    const { data: cor } = await supabase.from("questions").select("id, correct_option, subject_id, subjects(name)").in("id", ids);
    const corMap = new Map((cor ?? []).map((c: any) => [c.id, c]));

    for (const q of questions as any[]) {
      const sel = answers[q.id] ?? "NONE";
      const c = corMap.get(q.id) as any;
      const subjName = c?.subjects?.name ?? "Other";
      subjScores[subjName] ??= { correct: 0, wrong: 0, score: 0 };
      if (sel === "NONE") unattempted++;
      else if (c && sel === c.correct_option) {
        correct++; subjScores[subjName].correct++; subjScores[subjName].score += exam.marks_per_correct;
      } else {
        wrong++; subjScores[subjName].wrong++; subjScores[subjName].score -= exam.marks_per_correct * Number(exam.negative_marking_ratio);
      }
    }
    const totalScore = correct * exam.marks_per_correct - wrong * exam.marks_per_correct * Number(exam.negative_marking_ratio);

    await supabase.from("student_exams").update({
      status: reason ? "TERMINATED" : "SUBMITTED",
      submitted_at: new Date().toISOString(),
      total_score: totalScore,
      termination_reason: reason ?? null,
    }).eq("id", studentExamId);

    await supabase.from("exam_results").insert({
      student_exam_id: studentExamId,
      total_correct: correct, total_wrong: wrong, total_unattempted: unattempted,
      subject_wise_scores: subjScores,
    });

    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch {}
    navigate({ to: "/student/results/$studentExamId", params: { studentExamId } });
  }, [studentExamId, exam, questions, answers, navigate]);

  // Auto-submit at zero
  useEffect(() => {
    if (secondsLeft === 0 && !submittedRef.current) submit("Time expired");
  }, [secondsLeft, submit]);

  // Lockdown listeners
  useEffect(() => {
    if (!studentExamId) return;
    const flag = (why: string) => {
      setViolations((v) => {
        const nv = v + 1;
        toast.warning(`Violation ${nv}/3: ${why}`);
        if (nv >= 3) submit(`Auto-terminated: ${why}`);
        return nv;
      });
    };
    const enteredFs = !!document.fullscreenElement;
    const onVis = () => { if (document.hidden) flag("tab switched"); };
    const onFs = () => { if (enteredFs && !document.fullscreenElement && !submittedRef.current) flag("exited fullscreen"); };
    const onCopy = (e: ClipboardEvent) => { e.preventDefault(); flag("copy attempt"); };
    const onCtx = (e: MouseEvent) => e.preventDefault();
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("copy", onCopy);
    document.addEventListener("contextmenu", onCtx);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [studentExamId, submit]);

  const current = (questions as any[] | undefined)?.[idx];
  useEffect(() => { if (current) setVisited((v) => ({ ...v, [current.id]: true })); }, [current]);

  async function persist(qid: string, letter: Letter, mark?: boolean) {
    if (!studentExamId) return;
    const isMark = mark ?? !!marked[qid];
    await supabase.from("student_answers").upsert({
      student_exam_id: studentExamId, question_id: qid, selected_option: letter,
      is_marked_for_review: isMark, answered_at: letter === "NONE" ? null : new Date().toISOString(),
    }, { onConflict: "student_exam_id,question_id" });
  }

  function pick(letter: Letter) {
    if (!current) return;
    setAnswers((a) => ({ ...a, [current.id]: letter }));
    persist(current.id, letter);
  }
  function toggleMark() {
    if (!current) return;
    const nm = !marked[current.id];
    setMarked((m) => ({ ...m, [current.id]: nm }));
    persist(current.id, answers[current.id] ?? "NONE", nm);
  }
  function clearAns() { if (current) { setAnswers((a) => ({ ...a, [current.id]: "NONE" })); persist(current.id, "NONE"); } }

  const stats = useMemo(() => {
    const qs = (questions as any[]) ?? [];
    let answered = 0, mk = 0, notVisited = 0, notAnswered = 0;
    qs.forEach((q) => {
      const ans = answers[q.id] && answers[q.id] !== "NONE";
      const m = marked[q.id]; const v = visited[q.id];
      if (ans) answered++; if (m) mk++; if (!v) notVisited++; else if (!ans) notAnswered++;
    });
    return { answered, mk, notVisited, notAnswered, total: qs.length };
  }, [questions, answers, marked, visited]);

  if (!exam || !questions || !current) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading exam…</div>;

  const mm = Math.floor((secondsLeft ?? 0) / 60); const ss = (secondsLeft ?? 0) % 60;
  const lowTime = (secondsLeft ?? 999) < 300;

  return (
    <div className="h-screen flex flex-col bg-muted/30 overflow-hidden select-none" onCopy={(e) => e.preventDefault()}>
      <header className="bg-primary text-primary-foreground px-4 py-2 flex items-center justify-between">
        <Logo className="text-primary-foreground [&_.text-muted-foreground]:text-primary-foreground/60" />
        <div className={`px-4 py-1.5 rounded-md font-mono text-lg font-bold tabular-nums ${lowTime ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-primary-foreground/10"}`}>
          {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
        </div>
        <div className="text-xs opacity-80 hidden md:block">{exam.title}</div>
      </header>

      {violations > 0 && (
        <div className="bg-warning/15 text-warning text-xs px-4 py-1.5 flex items-center gap-2 border-b">
          <AlertTriangle className="h-3.5 w-3.5" /> Violations: {violations}/3 — further violations will auto-submit your exam.
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-3 text-xs text-muted-foreground">
              <div>Question {idx + 1} of {questions.length} · {current.subjects?.name ?? ""}</div>
              <div>+{exam.marks_per_correct} / -{(exam.marks_per_correct * Number(exam.negative_marking_ratio)).toFixed(2)}</div>
            </div>
            <div className="text-base leading-relaxed whitespace-pre-wrap">{current.question_text}</div>

            <div className="mt-6 space-y-2">
              {(["A", "B", "C", "D"] as const).map((L) => {
                const txt = current[`option_${L.toLowerCase()}` as "option_a"];
                const sel = answers[current.id] === L;
                return (
                  <button key={L} onClick={() => pick(L)}
                    className={`w-full text-left rounded-md border px-4 py-3 transition-colors ${sel ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"}`}>
                    <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full mr-3 text-xs font-semibold ${sel ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{L}</span>
                    <span className="whitespace-pre-wrap">{txt}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-8 flex flex-wrap gap-2 justify-between border-t pt-4">
              <div className="flex gap-2">
                <Button variant="outline" onClick={clearAns}>Clear Response</Button>
                <Button variant="outline" onClick={toggleMark}><Flag className="h-4 w-4 mr-1" /> {marked[current.id] ? "Unmark" : "Mark for Review"}</Button>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" disabled={idx === 0} onClick={() => setIdx((i) => i - 1)}><ChevronLeft className="h-4 w-4" /> Prev</Button>
                <Button onClick={() => setIdx((i) => Math.min(questions.length - 1, i + 1))}>Save & Next <ChevronRight className="h-4 w-4 ml-1" /></Button>
              </div>
            </div>
          </div>
        </div>

        <aside className="hidden md:flex w-72 flex-col bg-background border-l">
          <div className="p-3 border-b grid grid-cols-2 gap-2 text-xs">
            <Legend cls="bg-success text-white" n={stats.answered} l="Answered" />
            <Legend cls="bg-destructive text-white" n={stats.notAnswered} l="Not answered" />
            <Legend cls="bg-muted text-muted-foreground border" n={stats.notVisited} l="Not visited" />
            <Legend cls="bg-info text-white" n={stats.mk} l="Marked" />
          </div>
          <div className="flex-1 overflow-y-auto p-3 grid grid-cols-5 gap-2">
            {(questions as any[]).map((q, i) => {
              const ans = answers[q.id] && answers[q.id] !== "NONE";
              const m = marked[q.id]; const v = visited[q.id];
              const cls = m && ans ? "bg-info text-white" : m ? "bg-info/60 text-white"
                : ans ? "bg-success text-white"
                : v ? "bg-destructive text-white"
                : "bg-muted text-muted-foreground border";
              return (
                <button key={q.id} onClick={() => setIdx(i)}
                  className={`h-9 rounded text-xs font-semibold ${cls} ${i === idx ? "ring-2 ring-primary" : ""}`}>
                  {i + 1}
                </button>
              );
            })}
          </div>
          <div className="p-3 border-t">
            <Button className="w-full" disabled={submitting} onClick={() => { if (confirm(`Submit exam? Answered: ${stats.answered}/${stats.total}`)) submit(); }}>
              <Send className="h-4 w-4 mr-2" /> Submit Exam
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Legend({ cls, n, l }: { cls: string; n: number; l: string }) {
  return <div className="flex items-center gap-2"><span className={`inline-flex h-6 w-6 items-center justify-center rounded text-[10px] font-semibold ${cls}`}>{n}</span><span className="text-muted-foreground">{l}</span></div>;
}
