import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const recomputeResults = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ examId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { examId } = data;

    // Fetch exam scoring config
    const { data: exam, error: examErr } = await supabaseAdmin
      .from("exams")
      .select("id, marks_per_correct, negative_marking_ratio")
      .eq("id", examId)
      .single();
    if (examErr || !exam) throw new Error("Exam not found");

    const correctMarks = Number(exam.marks_per_correct ?? 4);
    const negRatio = Number(exam.negative_marking_ratio ?? 1);
    const negMarks = correctMarks * negRatio;

    // Questions in exam (with correct answer + subject)
    const { data: eqs } = await supabaseAdmin
      .from("exam_questions")
      .select("question_id, questions!inner(id, correct_option, subject_id, subjects(name))")
      .eq("exam_id", examId);
    const qMap = new Map<string, { correct: string; subjectId: string; subjectName: string }>();
    (eqs ?? []).forEach((row: any) => {
      qMap.set(row.question_id, {
        correct: row.questions.correct_option,
        subjectId: row.questions.subject_id,
        subjectName: row.questions.subjects?.name ?? "—",
      });
    });
    const totalQuestions = qMap.size;

    // All finished attempts
    const { data: attempts } = await supabaseAdmin
      .from("student_exams")
      .select("id, student_id, status")
      .eq("exam_id", examId)
      .in("status", ["SUBMITTED", "TERMINATED"]);

    if (!attempts?.length) return { updated: 0, totalQuestions };

    // Pull all answers in one query
    const ids = attempts.map((a) => a.id);
    const { data: answers } = await supabaseAdmin
      .from("student_answers")
      .select("student_exam_id, question_id, selected_option")
      .in("student_exam_id", ids);

    const byAttempt = new Map<string, Map<string, string>>();
    (answers ?? []).forEach((a) => {
      if (!byAttempt.has(a.student_exam_id)) byAttempt.set(a.student_exam_id, new Map());
      byAttempt.get(a.student_exam_id)!.set(a.question_id, a.selected_option);
    });

    type Computed = {
      attemptId: string;
      total_correct: number;
      total_wrong: number;
      total_unattempted: number;
      total_score: number;
      subject_wise_scores: Record<string, { correct: number; wrong: number; unattempted: number; score: number }>;
    };

    const computed: Computed[] = attempts.map((a) => {
      const ans = byAttempt.get(a.id) ?? new Map<string, string>();
      let correct = 0, wrong = 0, unatt = 0, score = 0;
      const subj: Record<string, { correct: number; wrong: number; unattempted: number; score: number }> = {};
      const ensure = (name: string) => (subj[name] ??= { correct: 0, wrong: 0, unattempted: 0, score: 0 });

      qMap.forEach((meta, qid) => {
        const s = ensure(meta.subjectName);
        const sel = ans.get(qid);
        if (!sel || sel === "NONE") {
          unatt++; s.unattempted++;
        } else if (sel === meta.correct) {
          correct++; s.correct++;
          score += correctMarks; s.score += correctMarks;
        } else {
          wrong++; s.wrong++;
          score -= negMarks; s.score -= negMarks;
        }
      });

      return {
        attemptId: a.id,
        total_correct: correct,
        total_wrong: wrong,
        total_unattempted: unatt,
        total_score: Number(score.toFixed(2)),
        subject_wise_scores: subj,
      };
    });

    // Rank + percentile (dense rank by score desc; ties share rank)
    const sorted = [...computed].sort((a, b) => b.total_score - a.total_score);
    const rankByAttempt = new Map<string, number>();
    let lastScore: number | null = null;
    let lastRank = 0;
    sorted.forEach((c, i) => {
      const rank = lastScore !== null && c.total_score === lastScore ? lastRank : i + 1;
      lastScore = c.total_score; lastRank = rank;
      rankByAttempt.set(c.attemptId, rank);
    });
    const n = sorted.length;

    // Update student_exams.total_score
    await Promise.all(
      computed.map((c) =>
        supabaseAdmin.from("student_exams").update({ total_score: c.total_score }).eq("id", c.attemptId),
      ),
    );

    // Upsert exam_results
    const rows = computed.map((c) => {
      const rank = rankByAttempt.get(c.attemptId)!;
      const percentile = n > 1 ? Number((((n - rank) / (n - 1)) * 100).toFixed(2)) : 100;
      return {
        student_exam_id: c.attemptId,
        total_correct: c.total_correct,
        total_wrong: c.total_wrong,
        total_unattempted: c.total_unattempted,
        subject_wise_scores: c.subject_wise_scores,
        rank,
        percentile,
      };
    });

    const { error: upErr } = await supabaseAdmin
      .from("exam_results")
      .upsert(rows, { onConflict: "student_exam_id" });
    if (upErr) throw new Error(upErr.message);

    await supabaseAdmin.from("audit_logs").insert({
      action: "RECOMPUTE_RESULTS",
      details: `Recomputed ${rows.length} results for exam ${examId}`,
    });

    return { updated: rows.length, totalQuestions };
  });
