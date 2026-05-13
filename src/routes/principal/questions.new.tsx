import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { Upload, X } from "lucide-react";
// @ts-ignore - no types
import { BlockMath } from "react-katex";

export const Route = createFileRoute("/principal/questions/new")({ component: NewQuestion });

function ImageUpload({ value, onChange, label }: { value: string | null; onChange: (url: string | null) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const ext = file.name.split(".").pop() || "png";
      const path = `${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from("question-images").upload(path, file, { upsert: false });
      if (error) throw error;
      const { data } = supabase.storage.from("question-images").getPublicUrl(path);
      onChange(data.publicUrl);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-2">
      <input ref={ref} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
      {value ? (
        <div className="flex items-center gap-2">
          <img src={value} alt="" className="h-10 w-10 rounded border object-cover" />
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}><X className="h-3 w-3" /></Button>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => ref.current?.click()}>
          <Upload className="h-3 w-3 mr-1" />{busy ? "..." : label}
        </Button>
      )}
    </div>
  );
}

function MathPreview({ text }: { text: string }) {
  // Render $$...$$ blocks as KaTeX
  const parts = text.split(/(\$\$[^$]+\$\$)/g);
  return (
    <div className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed">
      {parts.map((p, i) => {
        if (p.startsWith("$$") && p.endsWith("$$")) {
          const formula = p.slice(2, -2);
          try {
            return <BlockMath key={i} math={formula} />;
          } catch {
            return <code key={i}>{p}</code>;
          }
        }
        return <span key={i}>{p}</span>;
      })}
    </div>
  );
}

function NewQuestion() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: subjects } = useQuery({
    queryKey: ["subjects-list"],
    queryFn: async () => (await supabase.from("subjects").select("id, name").eq("is_archived", false).order("name")).data ?? [],
  });

  const [form, setForm] = useState({
    subject_id: "",
    topic_tag: "",
    difficulty: "Medium" as "Easy" | "Medium" | "Hard",
    marks: 4,
    negative_marks: 1,
    question_text: "",
    question_image: null as string | null,
    option_a: "", option_b: "", option_c: "", option_d: "",
    option_a_image: null as string | null,
    option_b_image: null as string | null,
    option_c_image: null as string | null,
    option_d_image: null as string | null,
    correct_option: "A" as "A" | "B" | "C" | "D",
    solution_text: "",
    solution_image: null as string | null,
  });
  const [saving, setSaving] = useState(false);

  const submit = async (addAnother: boolean) => {
    if (!form.subject_id) { toast.error("Select a subject"); return; }
    if (!form.question_text.trim()) { toast.error("Question text required"); return; }
    setSaving(true);
    try {
      const { data: q, error } = await supabase.from("questions").insert({
        subject_id: form.subject_id,
        topic_tag: form.topic_tag || null,
        difficulty: form.difficulty,
        marks: form.marks,
        negative_marks: form.negative_marks,
        question_text: form.question_text,
        question_image: form.question_image,
        option_a: form.option_a, option_b: form.option_b, option_c: form.option_c, option_d: form.option_d,
        option_a_image: form.option_a_image, option_b_image: form.option_b_image,
        option_c_image: form.option_c_image, option_d_image: form.option_d_image,
        correct_option: form.correct_option,
        created_by: user?.id,
      }).select("id").single();
      if (error) throw error;
      if ((form.solution_text.trim() || form.solution_image) && q) {
        await supabase.from("solutions").insert({ question_id: q.id, solution_text: form.solution_text || "", solution_image: form.solution_image });
      }
      toast.success("Question saved");
      if (addAnother) {
        setForm((f) => ({ ...f, question_text: "", question_image: null, option_a: "", option_b: "", option_c: "", option_d: "", option_a_image: null, option_b_image: null, option_c_image: null, option_d_image: null, solution_text: "", solution_image: null, topic_tag: f.topic_tag }));
      } else {
        navigate({ to: "/principal/questions" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally { setSaving(false); }
  };

  return (
    <PrincipalShell>
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">New Question</h1>
        <p className="text-sm text-muted-foreground mt-1">Use <code>$$...$$</code> for LaTeX math</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Subject</Label>
              <select value={form.subject_id} onChange={(e) => setForm({ ...form, subject_id: e.target.value })} className="w-full border rounded-md px-3 py-2 text-sm bg-background">
                <option value="">Select…</option>
                {subjects?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Difficulty</Label>
              <select value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: e.target.value as any })} className="w-full border rounded-md px-3 py-2 text-sm bg-background">
                <option>Easy</option><option>Medium</option><option>Hard</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Topic tag</Label>
              <Input value={form.topic_tag} onChange={(e) => setForm({ ...form, topic_tag: e.target.value })} placeholder="e.g. Kinematics" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2"><Label>Marks +</Label><Input type="number" value={form.marks} onChange={(e) => setForm({ ...form, marks: Number(e.target.value) })} /></div>
              <div className="space-y-2"><Label>Marks −</Label><Input type="number" value={form.negative_marks} onChange={(e) => setForm({ ...form, negative_marks: Number(e.target.value) })} /></div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Question text</Label>
            <Textarea rows={5} value={form.question_text} onChange={(e) => setForm({ ...form, question_text: e.target.value })} placeholder="Find the value of $$\\int_0^1 x^2 dx$$" />
          </div>

          {(["A", "B", "C", "D"] as const).map((opt) => (
            <div key={opt} className="flex gap-2 items-start">
              <label className="flex items-center gap-2 mt-2">
                <input type="radio" checked={form.correct_option === opt} onChange={() => setForm({ ...form, correct_option: opt })} />
                <span className="font-bold w-5">{opt}</span>
              </label>
              <Input
                value={(form as any)[`option_${opt.toLowerCase()}`]}
                onChange={(e) => setForm({ ...form, [`option_${opt.toLowerCase()}`]: e.target.value } as any)}
                placeholder={`Option ${opt}`}
              />
            </div>
          ))}

          <div className="space-y-2">
            <Label>Solution (optional)</Label>
            <Textarea rows={3} value={form.solution_text} onChange={(e) => setForm({ ...form, solution_text: e.target.value })} />
          </div>

          <div className="flex gap-2">
            <Button onClick={() => submit(false)} disabled={saving}>Save Question</Button>
            <Button variant="outline" onClick={() => submit(true)} disabled={saving}>Save & Add Another</Button>
            <Button variant="ghost" onClick={() => navigate({ to: "/principal/questions" })}>Cancel</Button>
          </div>
        </Card>

        <Card className="p-6 sticky top-6 self-start">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-4">Live Preview</h3>
          <div className="space-y-4">
            <MathPreview text={form.question_text || "Question preview will appear here."} />
            <div className="space-y-2">
              {(["A", "B", "C", "D"] as const).map((opt) => {
                const v = (form as any)[`option_${opt.toLowerCase()}`] as string;
                return (
                  <div key={opt} className={`flex gap-2 rounded-md border p-3 text-sm ${form.correct_option === opt ? "border-success bg-success/5" : ""}`}>
                    <span className="font-bold">{opt}.</span>
                    <span>{v || <em className="text-muted-foreground">empty</em>}</span>
                  </div>
                );
              })}
            </div>
            {form.solution_text && (
              <div className="rounded-md border border-info/30 bg-info/5 p-3 text-sm">
                <div className="font-semibold mb-1">Solution</div>
                <MathPreview text={form.solution_text} />
              </div>
            )}
          </div>
        </Card>
      </div>
    </PrincipalShell>
  );
}
