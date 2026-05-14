import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { Logo } from "@/components/Logo";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { LogOut } from "lucide-react";

export const Route = createFileRoute("/student/")({ component: StudentDashboard });

function StudentDashboard() {
  const navigate = useNavigate();
  const { user, role, loading, fullName, signOut } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) navigate({ to: "/login" });
    else if (role === "PRINCIPAL") navigate({ to: "/principal" });
  }, [user, role, loading, navigate]);

  const { data: exams } = useQuery({
    queryKey: ["student-exams", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("exam_assignments")
        .select("exam_id, exams(id, title, description, scheduled_date, start_time, duration_minutes, status)")
        .eq("student_id", user!.id);
      return (data ?? []).map((r: any) => r.exams).filter(Boolean);
    },
  });

  const { data: attempts } = useQuery({
    queryKey: ["student-attempts", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from("student_exams").select("id, exam_id, status").eq("student_id", user!.id);
      const m = new Map<string, { id: string; status: string }>();
      (data ?? []).forEach((r) => m.set(r.exam_id, { id: r.id, status: r.status }));
      return m;
    },
  });

  if (loading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="bg-primary text-primary-foreground">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <Logo className="text-primary-foreground [&_.text-muted-foreground]:text-primary-foreground/60" />
          <div className="flex items-center gap-3">
            <div className="text-sm text-right">
              <div className="font-medium">{fullName ?? user.email}</div>
              <div className="text-xs opacity-70">Student</div>
            </div>
            <Button asChild size="sm" variant="secondary">
              <Link to="/student/results">My Results</Link>
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { signOut(); navigate({ to: "/login" }); }}>
              <LogOut className="h-4 w-4 mr-1" /> Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="text-2xl font-bold tracking-tight">Hello, {fullName ?? "Student"}</h1>
        <p className="text-sm text-muted-foreground mt-1">{new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>

        <section className="mt-8">
          <h2 className="text-lg font-semibold mb-4">Your Exams</h2>
          {exams && exams.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {exams.map((e: any) => {
                const att = attempts?.get(e.id);
                const finished = att?.status === "SUBMITTED" || att?.status === "TERMINATED";
                const canStart = (e.status === "ONGOING" || e.status === "SCHEDULED") && !finished;
                return (
                  <Card key={e.id} className="p-5">
                    <h3 className="font-semibold">{e.title}</h3>
                    <p className="text-xs text-muted-foreground mt-1">{e.scheduled_date ?? "—"} {e.start_time ?? ""} • {e.duration_minutes} min</p>
                    <div className="mt-3 flex items-center justify-between">
                      <span className={`text-xs rounded-full px-2 py-0.5 ${
                        e.status === "ONGOING" ? "bg-success/15 text-success" :
                        e.status === "COMPLETED" ? "bg-muted text-muted-foreground" :
                        "bg-info/15 text-info"
                      }`}>{finished ? "DONE" : e.status}</span>
                      {finished ? (
                        <Button size="sm" variant="outline" onClick={() => navigate({ to: "/student/results/$studentExamId", params: { studentExamId: att!.id } })}>View Result</Button>
                      ) : (
                        <Button size="sm" disabled={!canStart} onClick={() => navigate({ to: "/student/exam/$examId", params: { examId: e.id } })}>Start</Button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          ) : (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              No exams assigned to you yet. Check back later.
            </Card>
          )}
        </section>
      </main>
    </div>
  );
}
