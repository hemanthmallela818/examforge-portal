import { GraduationCap } from "lucide-react";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <GraduationCap className="h-5 w-5" />
      </div>
      <div className="leading-tight">
        <div className="text-lg font-bold tracking-tight">ExamForge</div>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
          Competitive Exam Portal
        </div>
      </div>
    </div>
  );
}
