import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/principal/questions")({ component: QuestionBank });

function QuestionBank() {
  const [search, setSearch] = useState("");
  const [subjectId, setSubjectId] = useState<string>("");

  const { data: subjects } = useQuery({
    queryKey: ["subjects-list"],
    queryFn: async () => (await supabase.from("subjects").select("id, name").eq("is_archived", false).order("name")).data ?? [],
  });

  const { data: questions, isLoading } = useQuery({
    queryKey: ["questions", subjectId, search],
    queryFn: async () => {
      let q = supabase.from("questions").select("id, question_text, difficulty, topic_tag, subject_id, subjects(name)").order("created_at", { ascending: false }).limit(200);
      if (subjectId) q = q.eq("subject_id", subjectId);
      if (search) q = q.ilike("question_text", `%${search}%`);
      const { data } = await q;
      return data ?? [];
    },
  });

  return (
    <PrincipalShell>
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Question Bank</h1>
          <p className="text-sm text-muted-foreground mt-1">All questions across subjects</p>
        </div>
        <Button asChild><Link to="/principal/questions/new">Add Question</Link></Button>
      </header>

      <Card className="p-4 mb-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} className="border rounded-md px-3 py-2 text-sm bg-background">
            <option value="">All subjects</option>
            {subjects?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <Input placeholder="Search question text…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">Topic</th>
              <th className="px-4 py-3">Difficulty</th>
              <th className="px-4 py-3">Question</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>}
            {questions?.map((q: any) => (
              <tr key={q.id}>
                <td className="px-4 py-3">{q.subjects?.name ?? "—"}</td>
                <td className="px-4 py-3 text-muted-foreground">{q.topic_tag ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className="text-xs rounded-full bg-muted px-2 py-0.5">{q.difficulty}</span>
                </td>
                <td className="px-4 py-3 max-w-xl truncate">{q.question_text.slice(0, 120)}</td>
              </tr>
            ))}
            {questions && questions.length === 0 && !isLoading && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No questions yet. Add your first one.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </PrincipalShell>
  );
}
