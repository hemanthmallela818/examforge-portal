import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { extractQuestions } from "@/lib/extract.functions";
import { toast } from "sonner";
import { Sparkles, Loader2 } from "lucide-react";

export const Route = createFileRoute("/principal/questions/import")({ component: ImportQuestions });

type Extracted = {
  question_text: string;
  option_a: string; option_b: string; option_c: string; option_d: string;
  correct_option: "A" | "B" | "C" | "D";
  difficulty: "Easy" | "Medium" | "Hard";
  topic_tag?: string | null;
  solution_text?: string | null;
};

function ImportQuestions() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const extract = useServerFn(extractQuestions);

  const { data: subjects } = useQuery({
    queryKey: ["subjects-list"],
    queryFn: async () => (await supabase.from("subjects").select("id, name").eq("is_archived", false).order("name")).data ?? [],
  });

  const [text, setText] = useState("");
  const [hint, setHint] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState<Extracted[]>([]);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [saving, setSaving] = useState(false);

  async function onFile(f: File | null) {
    if (!f) return;
    if (f.type === "application/pdf") {
      toast.message("PDF detected — paste the extracted text instead, or upload a .txt file.");
      return;
    }
    const txt = await f.text();
    setText(txt);
  }

  async function run() {
    if (!text.trim()) return toast.error("Paste source text first");
    setRunning(true); setItems([]); setSelected({});
    try {
      const r = await extract({ data: { text, hint: hint || undefined } });
      setItems(r.questions as Extracted[]);
      const sel: Record<number, boolean> = {};
      (r.questions as Extracted[]).forEach((_, i) => (sel[i] = true));
      setSelected(sel);
      toast.success(`Extracted ${r.count} questions`);
    } catch (e: any) {
      toast.error(e?.message ?? "Extraction failed");
    } finally { setRunning(false); }
  }

  function update(i: number, patch: Partial<Extracted>) {
    setItems((arr) => arr.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  }

  async function saveAll() {
    if (!subjectId) return toast.error("Pick a subject first");
    const picks = items.filter((_, i) => selected[i]);
    if (!picks.length) return toast.error("Select at least one question");
    setSaving(true);
    try {
      const { data: inserted, error } = await supabase.from("questions").insert(
        picks.map((q) => ({
          subject_id: subjectId,
          question_text: q.question_text,
          option_a: q.option_a, option_b: q.option_b, option_c: q.option_c, option_d: q.option_d,
          correct_option: q.correct_option,
          difficulty: q.difficulty,
          topic_tag: q.topic_tag || null,
          created_by: user?.id,
        })),
      ).select("id");
      if (error) throw error;

      const sols = picks
        .map((q, i) => (q.solution_text ? { question_id: inserted![i].id, solution_text: q.solution_text } : null))
        .filter(Boolean) as { question_id: string; solution_text: string }[];
      if (sols.length) await supabase.from("solutions").insert(sols);

      await supabase.from("audit_logs").insert({ action: "AI_IMPORT", details: `Imported ${picks.length} questions via AI` });
      toast.success(`Saved ${picks.length} questions`);
      navigate({ to: "/principal/questions" });
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    } finally { setSaving(false); }
  }

  return (
    <PrincipalShell>
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2"><Sparkles className="h-6 w-6 text-primary" /> AI Question Import</h1>
          <p className="text-sm text-muted-foreground mt-1">Paste source text or upload a .txt — Lovable AI extracts MCQs you can edit and save.</p>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6 space-y-4">
          <div className="space-y-2">
            <Label>Subject (where extracted questions go)</Label>
            <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} className="w-full border rounded-md px-3 py-2 text-sm bg-background">
              <option value="">Select subject…</option>
              {subjects?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label>Hint (optional, e.g. "Physics – Kinematics chapter")</Label>
            <Input value={hint} onChange={(e) => setHint(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Source text</Label>
            <Textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste content with MCQs (and answers/solutions if available)…" />
            <input type="file" accept=".txt,text/plain,application/pdf" className="text-xs" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-muted-foreground">Tip: For PDFs, copy text out (Cmd/Ctrl+A) and paste here.</p>
          </div>
          <Button onClick={run} disabled={running}>
            {running ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Extracting…</> : <><Sparkles className="h-4 w-4 mr-2" /> Extract with AI</>}
          </Button>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Extracted ({items.length})</h3>
            {items.length > 0 && <Button size="sm" disabled={saving} onClick={saveAll}>{saving ? "Saving…" : `Save Selected`}</Button>}
          </div>
          {items.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-12">Extracted questions will appear here.</div>
          ) : (
            <div className="space-y-4 max-h-[640px] overflow-y-auto pr-2">
              {items.map((q, i) => (
                <div key={i} className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox checked={!!selected[i]} onCheckedChange={(v) => setSelected((s) => ({ ...s, [i]: !!v }))} />
                      Q{i + 1}
                    </label>
                    <div className="flex gap-2 text-xs">
                      <select value={q.difficulty} onChange={(e) => update(i, { difficulty: e.target.value as any })} className="border rounded px-2 py-0.5">
                        <option>Easy</option><option>Medium</option><option>Hard</option>
                      </select>
                      <select value={q.correct_option} onChange={(e) => update(i, { correct_option: e.target.value as any })} className="border rounded px-2 py-0.5">
                        {(["A","B","C","D"] as const).map((L) => <option key={L} value={L}>Ans: {L}</option>)}
                      </select>
                    </div>
                  </div>
                  <Textarea rows={2} value={q.question_text} onChange={(e) => update(i, { question_text: e.target.value })} className="text-sm" />
                  {(["A","B","C","D"] as const).map((L) => (
                    <Input key={L} value={(q as any)[`option_${L.toLowerCase()}`]} onChange={(e) => update(i, { [`option_${L.toLowerCase()}`]: e.target.value } as any)} placeholder={L} className="text-sm" />
                  ))}
                  <Input value={q.topic_tag ?? ""} onChange={(e) => update(i, { topic_tag: e.target.value })} placeholder="Topic tag" className="text-xs" />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </PrincipalShell>
  );
}
