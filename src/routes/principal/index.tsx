import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { Users, FileText, Activity, Library } from "lucide-react";

export const Route = createFileRoute("/principal/")({ component: PrincipalDashboard });

function PrincipalDashboard() {
  const { data: stats } = useQuery({
    queryKey: ["principal-stats"],
    queryFn: async () => {
      const [students, exams, ongoing, questions] = await Promise.all([
        supabase.from("user_roles").select("*", { count: "exact", head: true }).eq("role", "STUDENT"),
        supabase.from("exams").select("*", { count: "exact", head: true }),
        supabase.from("exams").select("*", { count: "exact", head: true }).eq("status", "ONGOING"),
        supabase.from("questions").select("*", { count: "exact", head: true }),
      ]);
      return {
        students: students.count ?? 0,
        exams: exams.count ?? 0,
        ongoing: ongoing.count ?? 0,
        questions: questions.count ?? 0,
      };
    },
  });

  const { data: logs } = useQuery({
    queryKey: ["recent-audit"],
    queryFn: async () => {
      const { data } = await supabase
        .from("audit_logs")
        .select("id, action, details, created_at")
        .order("created_at", { ascending: false })
        .limit(10);
      return data ?? [];
    },
  });

  const cards = [
    { label: "Active Students", value: stats?.students ?? "—", icon: Users },
    { label: "Total Exams", value: stats?.exams ?? "—", icon: FileText },
    { label: "Ongoing Exams", value: stats?.ongoing ?? "—", icon: Activity },
    { label: "Question Bank", value: stats?.questions ?? "—", icon: Library },
  ];

  return (
    <PrincipalShell>
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Principal Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">Control center for ExamForge</p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.label} className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.label}</div>
                  <div className="mt-2 text-3xl font-bold">{c.value}</div>
                </div>
                <Icon className="h-8 w-8 text-primary/60" />
              </div>
            </Card>
          );
        })}
      </div>

      <Card className="p-6 mb-8">
        <h2 className="text-lg font-semibold mb-4">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <Button asChild><Link to="/principal/questions/new">Add Question</Link></Button>
          <Button asChild variant="secondary"><Link to="/principal/students">Manage Students</Link></Button>
          <Button asChild variant="secondary"><Link to="/principal/subjects">Manage Subjects</Link></Button>
          <Button asChild variant="secondary"><Link to="/principal/questions">Question Bank</Link></Button>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="text-lg font-semibold mb-4">Recent Activity</h2>
        {logs && logs.length > 0 ? (
          <div className="divide-y">
            {logs.map((l) => (
              <div key={l.id} className="py-3 flex items-start justify-between gap-4 text-sm">
                <div>
                  <div className="font-medium">{l.action}</div>
                  {l.details && <div className="text-xs text-muted-foreground mt-0.5">{l.details}</div>}
                </div>
                <div className="text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(l.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        )}
      </Card>
    </PrincipalShell>
  );
}
