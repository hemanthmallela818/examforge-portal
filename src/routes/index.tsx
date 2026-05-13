import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { Logo } from "@/components/Logo";

export const Route = createFileRoute("/")({ component: Index });

function Index() {
  const { loading, user, role } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (!user) navigate({ to: "/login" });
    else if (role === "PRINCIPAL") navigate({ to: "/principal" });
    else if (role === "STUDENT") navigate({ to: "/student" });
    else navigate({ to: "/login" });
  }, [loading, user, role, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Logo />
    </div>
  );
}
