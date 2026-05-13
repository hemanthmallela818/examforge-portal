import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";

export const Route = createFileRoute("/principal/exams/new")({ component: ExamWizard });

const STEPS = ["Basics", "Subjects", "Questions", "Marking", "Students", "Review"] as const;

function ExamWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState(
    "• This exam contains multiple-choice questions.\n• Each correct answer carries +4 marks. Each wrong answer carries -1.\n• Switching tabs or exiting fullscreen will be flagged."
  );
  const [scheduledDate, setScheduledDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [duration, setDuration] = useState(180);

  const [subjectIds, setSubjectIds] = useState<string[]>([]);
  const [questionIds, setQuestionIds] = useState<string[]>([]);
  const [marksPerCorrect, setMarksPerCorrect] = useState(4);
  const [negRatio, setNegRatio] = useState(1);
  const [randomize, setRandomize] = useState(false);
  const [studentIds, setStudentIds] = useState<string[]>([]);

  const { data: subjects } = useQuery({
    queryKey: ["w-subjects"],
    queryFn: async () => (await supabase.from("subjects").select("id, name").eq("is_archived", false).order("name")).data ?? [],
  });

  const { data: questions } = useQuery({
    queryKey: ["w-questions", subjectIds],
    enabled: subjectIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("questions")
        .select("id, question_text, difficulty, topic_tag, subject_id, subjects(name)")
        .in("subject_id", subjectIds)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: students } = useQuery({
    queryKey: ["w-students"],
    queryFn: async () => {
      const { data: roles } = await supabase.from("user_roles").select("user_id").eq("role", "STUDENT");
      const ids = (roles ?? []).map((r) => r.user_id);
      if (!ids.length) return [];
      const { data } = await supabase.from("profiles").select("id, full_name, email").in("id", ids).eq("is_active", true).order("full_name");
      return data ?? [];
    },
  });

  const canNext = useMemo(() => {
    if (step === 0) return title.trim().length > 1 && duration > 0;
    if (step === 1) return subjectIds.length > 0;
    if (step === 2) return questionIds.length > 0;
    if (step === 4) return studentIds.length > 0;
    return true;
  }, [step, title, duration, subjectIds, questionIds, studentIds]);

  function toggle(arr: string[], setArr: (v: string[]) => void, id: string) {
    setArr(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  }

  async function save(asDraft: boolean) {
    const { data: exam, error } = await supabase
      .from("exams")
      .insert({
        title,
        description: description || null,
        instructions: instructions || null,
        scheduled_date: scheduledDate || null,
        start_time: startTime || null,
        duration_minutes: duration,
        marks_per_correct: marksPerCorrect,
        negative_marking_ratio: negRatio,
        randomize_questions: randomize,
        status: asDraft ? "DRAFT" : "SCHEDULED",
      })
      .select("id")
      .single();
    if (error || !exam) return toast.error(error?.message ?? "Failed to create exam");

    if (subjectIds.length) {
      await supabase.from("exam_subjects").insert(subjectIds.map((subject_id) => ({ exam_id: exam.id, subject_id })));
    }
    if (questionIds.length) {
      await supabase.from("exam_questions").insert(questionIds.map((question_id, i) => ({ exam_id: exam.id, question_id, question_order: i + 1 })));
    }
    if (studentIds.length) {
      await supabase.from("exam_assignments").insert(studentIds.map((student_id) => ({ exam_id: exam.id, student_id })));
    }
    await supabase.from("audit_logs").insert({ action: "CREATE_EXAM", details: `Created exam: ${title}` });
    toast.success("Exam created");
    navigate({ to: "/principal/exams" });
  }

  return (
    <PrincipalShell>
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Create Exam</h1>
        <p className="text-sm text-muted-foreground mt-1">6-step wizard</p>
      </header>

      <div className="mb-6 flex items-center gap-2 overflow-x-auto">
        {STEPS.map((s, i) => (
          <div key={s} className={`flex items-center gap-2 text-xs ${i === step ? "text-primary font-semibold" : i < step ? "text-success" : "text-muted-foreground"}`}>
            <div className={`h-7 w-7 rounded-full flex items-center justify-center border ${i === step ? "border-primary bg-primary/10" : i < step ? "border-success bg-success/10" : "border-border"}`}>
              {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <span className="whitespace-nowrap">{s}</span>
            {i < STEPS.length - 1 && <ChevronRight className="h-3 w-3 opacity-40" />}
          </div>
        ))}
      </div>

      <Card className="p-6">
        {step === 0 && (
          <div className="space-y-4 max-w-xl">
            <div><Label>Title *</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="JEE Main Mock Test #1" /></div>
            <div><Label>Description</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></div>
            <div><Label>Instructions</Label><Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5} /></div>
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Date</Label><Input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} /></div>
              <div><Label>Start time</Label><Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></div>
              <div><Label>Duration (min) *</Label><Input type="number" value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            <p className="text-sm text-muted-foreground mb-3">Pick the subjects this exam covers.</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {subjects?.map((s) => (
                <label key={s.id} className={`border rounded-md px-3 py-2 cursor-pointer text-sm flex items-center gap-2 ${subjectIds.includes(s.id) ? "border-primary bg-primary/5" : ""}`}>
                  <Checkbox checked={subjectIds.includes(s.id)} onCheckedChange={() => toggle(subjectIds, setSubjectIds, s.id)} />
                  {s.name}
                </label>
              ))}
              {subjects && !subjects.length && <div className="text-sm text-muted-foreground">No subjects. Create some first.</div>}
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-muted-foreground">Selected: {questionIds.length} questions</p>
              <Button size="sm" variant="outline" onClick={() => setQuestionIds(questions?.map((q) => q.id) ?? [])}>Select all</Button>
            </div>
            <div className="max-h-[460px] overflow-y-auto border rounded-md divide-y">
              {questions?.map((q: any) => (
                <label key={q.id} className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40">
                  <Checkbox className="mt-1" checked={questionIds.includes(q.id)} onCheckedChange={() => toggle(questionIds, setQuestionIds, q.id)} />
                  <div className="flex-1 text-sm">
                    <div className="flex gap-2 text-xs text-muted-foreground mb-0.5">
                      <span>{q.subjects?.name}</span>·<span>{q.difficulty}</span>{q.topic_tag && <>·<span>{q.topic_tag}</span></>}
                    </div>
                    <div className="line-clamp-2">{q.question_text}</div>
                  </div>
                </label>
              ))}
              {questions && !questions.length && <div className="px-3 py-6 text-center text-sm text-muted-foreground">No questions in selected subjects.</div>}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4 max-w-md">
            <div><Label>Marks per correct answer</Label><Input type="number" value={marksPerCorrect} onChange={(e) => setMarksPerCorrect(Number(e.target.value))} /></div>
            <div><Label>Negative marking ratio (× marks)</Label><Input type="number" step="0.25" value={negRatio} onChange={(e) => setNegRatio(Number(e.target.value))} /><p className="text-xs text-muted-foreground mt-1">e.g. 0.25 = -1 for a +4 question</p></div>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={randomize} onCheckedChange={(v) => setRandomize(!!v)} /> Randomize question order per student</label>
          </div>
        )}

        {step === 4 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-muted-foreground">Assigned: {studentIds.length} students</p>
              <Button size="sm" variant="outline" onClick={() => setStudentIds(students?.map((s) => s.id) ?? [])}>Assign all</Button>
            </div>
            <div className="max-h-[460px] overflow-y-auto border rounded-md divide-y">
              {students?.map((s) => (
                <label key={s.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40 text-sm">
                  <Checkbox checked={studentIds.includes(s.id)} onCheckedChange={() => toggle(studentIds, setStudentIds, s.id)} />
                  <div className="flex-1"><div className="font-medium">{s.full_name}</div><div className="text-xs text-muted-foreground">{s.email}</div></div>
                </label>
              ))}
              {students && !students.length && <div className="px-3 py-6 text-center text-sm text-muted-foreground">No active students.</div>}
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-3 text-sm">
            <Row k="Title" v={title} />
            <Row k="Schedule" v={`${scheduledDate || "—"} ${startTime || ""}`} />
            <Row k="Duration" v={`${duration} minutes`} />
            <Row k="Subjects" v={String(subjectIds.length)} />
            <Row k="Questions" v={String(questionIds.length)} />
            <Row k="Marking" v={`+${marksPerCorrect} / -${(marksPerCorrect * negRatio).toFixed(2)}`} />
            <Row k="Students" v={String(studentIds.length)} />
            <Row k="Randomize" v={randomize ? "Yes" : "No"} />
          </div>
        )}

        <div className="mt-8 flex items-center justify-between border-t pt-4">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}><ChevronLeft className="h-4 w-4 mr-1" /> Back</Button>
          {step < STEPS.length - 1 ? (
            <Button disabled={!canNext} onClick={() => setStep((s) => s + 1)}>Next <ChevronRight className="h-4 w-4 ml-1" /></Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => save(true)}>Save as Draft</Button>
              <Button onClick={() => save(false)}>Schedule Exam</Button>
            </div>
          )}
        </div>
      </Card>
    </PrincipalShell>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between border-b pb-2"><span className="text-muted-foreground">{k}</span><span className="font-medium">{v}</span></div>;
}
