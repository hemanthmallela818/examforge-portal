import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/principal/subjects")({ component: SubjectsPage });

function SubjectsPage() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["subjects"],
    queryFn: async () => {
      const { data, error } = await supabase.from("subjects").select("id, name, is_archived, created_at").order("name");
      if (error) throw error;
      return data;
    },
  });

  const add = async () => {
    if (!name.trim()) return;
    const { error } = await supabase.from("subjects").insert({ name: name.trim() });
    if (error) toast.error(error.message);
    else { toast.success("Subject added"); setName(""); qc.invalidateQueries({ queryKey: ["subjects"] }); }
  };

  const toggleArchive = async (id: string, current: boolean) => {
    const { error } = await supabase.from("subjects").update({ is_archived: !current }).eq("id", id);
    if (error) toast.error(error.message);
    else qc.invalidateQueries({ queryKey: ["subjects"] });
  };

  return (
    <PrincipalShell>
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Subjects</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage exam subjects</p>
      </header>

      <Card className="p-5 mb-6">
        <div className="flex gap-2">
          <Input placeholder="New subject name (e.g. Physics)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <Button onClick={add}>Add Subject</Button>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Actions</th></tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && <tr><td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>}
            {data?.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-3 font-medium">{s.name}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs rounded-full px-2 py-0.5 ${s.is_archived ? "bg-muted text-muted-foreground" : "bg-success/15 text-success"}`}>
                    {s.is_archived ? "Archived" : "Active"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button size="sm" variant="outline" onClick={() => toggleArchive(s.id, s.is_archived)}>
                    {s.is_archived ? "Restore" : "Archive"}
                  </Button>
                </td>
              </tr>
            ))}
            {data && data.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">No subjects yet.</td></tr>}
          </tbody>
        </table>
      </Card>
    </PrincipalShell>
  );
}
