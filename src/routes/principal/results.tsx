import { createFileRoute } from "@tanstack/react-router";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/principal/results")({ component: () => (
  <PrincipalShell>
    <h1 className="text-3xl font-bold tracking-tight">Results & Analytics</h1>
    <Card className="p-8 mt-6 text-center text-sm text-muted-foreground">Available after the first exam is completed.</Card>
  </PrincipalShell>
)});
