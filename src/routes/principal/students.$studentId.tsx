import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { ChevronLeft, Mail, Calendar, Award } from "lucide-react";

export const Route = createFileRoute("/principal/students/$studentId")({ component: StudentProfile });

function StudentProfile() {
  const { studentId } = Route.useParams();

  const { data: profile } = useQuery({
    queryKey: ["sp-profile", studentId],
    queryFn: async () => (await supabase.from("profiles").select("*").eq("id", studentId).single()).data,
  });

  const { data: attempts } = useQuery({
    queryKey: ["sp-attempts", studentId],
    queryFn: async () => {
      const { data } = await supabase
        .from("student_exams")
        .select("id, status, total_score, started_at, submitted_at, termination_reason, exams(title)")
        .eq("student_id", studentId)
        .order("started_at", { ascending: false });
      return data ?? [];
    },
  });

  const totalDone = (attempts ?? []).filter((a: any) => a.status === "SUBMITTED" || a.status === "TERMINATED");
  const avg = totalDone.length ? totalDone.reduce((s: number, a: any) => s + Number(a.total_score ?? 0), 0) / totalDone.length : 0;

  return (
    <PrincipalShell>
      <div className="mb-4">
        <Button asChild variant="ghost" size="sm"><Link to="/principal/students"><ChevronLeft className="h-4 w-4 mr-1" /> Back to Students</Link></Button>
      </div>

      {!profile ? (
        <Card className="p-10 text-center text-muted-foreground">Loading…</Card>
      ) : (
        <>
          <Card className="p-6 mb-6">
            <div className="flex items-start gap-4">
              <div className="h-14 w-14 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xl font-semibold">
                {profile.full_name?.charAt(0).toUpperCase() ?? "?"}
              </div>
              <div className="flex-1">
                <h1 className="text-2xl font-bold">{profile.full_name}</h1>
                <div className="text-sm text-muted-foreground mt-1 flex flex-wrap gap-4">
                  <span className="flex items-center gap-1"><Mail className="h-3.5 w-3.5" /> {profile.email}</span>
                  <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" /> Joined {new Date(profile.created_at).toLocaleDateString()}</span>
                  <span className={`text-xs rounded-full px-2 py-0.5 ${profile.is_active ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}`}>{profile.is_active ? "Active" : "Inactive"}</span>
                </div>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-3 gap-3 mb-6">
            <Stat icon={<Award className="text-primary" />} k="Exams Taken" v={String(totalDone.length)} />
            <Stat icon={<Award className="text-success" />} k="Average Score" v={avg.toFixed(2)} />
            <Stat icon={<Award className="text-info" />} k="Best Score" v={totalDone.length ? Math.max(...totalDone.map((a: any) => Number(a.total_score ?? 0))).toFixed(2) : "—"} />
          </div>

          <h2 className="font-semibold mb-3">Exam History</h2>
          <Card className="overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-4 py-3">Exam</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Started</th><th className="px-4 py-3">Submitted</th><th className="px-4 py-3 text-right">Score</th></tr>
              </thead>
              <tbody className="divide-y">
                {attempts?.map((a: any) => (
                  <tr key={a.id}>
                    <td className="px-4 py-3 font-medium">{a.exams?.title ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs rounded-full px-2 py-0.5 ${
                        a.status === "SUBMITTED" ? "bg-success/15 text-success" :
                        a.status === "TERMINATED" ? "bg-destructive/15 text-destructive" :
                        a.status === "ONGOING" ? "bg-info/15 text-info" :
                        "bg-muted text-muted-foreground"
                      }`}>{a.status}</span>
                      {a.termination_reason && <div className="text-xs text-destructive mt-1">{a.termination_reason}</div>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{a.started_at ? new Date(a.started_at).toLocaleString() : "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{a.submitted_at ? new Date(a.submitted_at).toLocaleString() : "—"}</td>
                    <td className="px-4 py-3 text-right font-semibold">{a.total_score != null ? Number(a.total_score).toFixed(2) : "—"}</td>
                  </tr>
                ))}
                {attempts && !attempts.length && <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No exam attempts yet.</td></tr>}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </PrincipalShell>
  );
}

function Stat({ icon, k, v }: { icon: React.ReactNode; k: string; v: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}{k}</div>
      <div className="text-2xl font-bold mt-1">{v}</div>
    </Card>
  );
}
