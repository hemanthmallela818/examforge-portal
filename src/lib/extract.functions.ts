import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const QuestionSchema = z.object({
  question_text: z.string(),
  option_a: z.string(),
  option_b: z.string(),
  option_c: z.string(),
  option_d: z.string(),
  correct_option: z.enum(["A", "B", "C", "D"]),
  difficulty: z.enum(["Easy", "Medium", "Hard"]).default("Medium"),
  topic_tag: z.string().nullable().optional(),
  solution_text: z.string().nullable().optional(),
});

export const extractQuestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      text: z.string().min(20).max(120000),
      hint: z.string().max(500).optional(),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI gateway not configured");

    const sys = `You are a parser that extracts multiple-choice questions (MCQ) from raw text of academic source material (often JEE / NEET / competitive exam material).
Rules:
- Output ONLY a JSON object: {"questions":[ ... ]}
- Each question has: question_text (string, preserve LaTeX, use $$...$$ for math), option_a, option_b, option_c, option_d (strings), correct_option ("A"|"B"|"C"|"D"), difficulty ("Easy"|"Medium"|"Hard"), topic_tag (short phrase or null), solution_text (string or null).
- If correct option is not stated, infer it. If you cannot, omit that question.
- Skip non-question content (chapter intros, summaries).`;

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: (data.hint ? `Hint: ${data.hint}\n\n` : "") + "SOURCE:\n" + data.text },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (res.status === 429) throw new Error("Rate limit reached. Try again in a moment.");
    if (res.status === 402) throw new Error("AI credits exhausted. Add credits to continue.");
    if (!res.ok) throw new Error(`AI gateway error ${res.status}: ${await res.text()}`);

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any;
    try { parsed = JSON.parse(content); } catch { throw new Error("AI returned invalid JSON"); }
    const list = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions = list
      .map((q: any) => {
        const r = QuestionSchema.safeParse(q);
        return r.success ? r.data : null;
      })
      .filter(Boolean);

    return { questions, count: questions.length };
  });
