import { createFileRoute } from "@tanstack/react-router";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/principal/exams")({ component: () => (
  <PrincipalShell>
    <h1 className="text-3xl font-bold tracking-tight">Exams</h1>
    <Card className="p-8 mt-6 text-center text-sm text-muted-foreground">
      Exam creation wizard, scheduling, and live monitoring are coming in the next iteration.
    </Card>
  </PrincipalShell>
)});
