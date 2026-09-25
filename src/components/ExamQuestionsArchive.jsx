import { useState } from 'react';
import MathRenderer from './MathRenderer';
import StorageImage from './StorageImage';
import { Check, CheckCircle2, Copy, FileText, Hash, Search, SearchX } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, EmptyState, Input, cn } from './ui';

/**
 * @typedef {import('../types').ExamQuestion & { correctAnswer?: string | number | null }} ArchiveQuestion
 * @typedef {ArchiveQuestion & { subject: string, displayNumber: number }} ArchiveListQuestion
 * @typedef {object} ArchiveExam
 * @property {string} [title]
 * @property {{ subjects?: string[], questions?: Record<string, ArchiveQuestion[] | undefined> } | null} [questionsData]
 */

/** @param {{ exam: ArchiveExam | null | undefined }} props */
const ExamQuestionsArchive = ({ exam }) => {
  const [selectedSubject, setSelectedSubject] = useState('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [copied, setCopied] = useState(false);

  if (!exam || !exam.questionsData || !exam.questionsData.questions) {
    return null;
  }

  const { subjects, questions } = exam.questionsData;

  // Flatten all questions with their subject
  /** @type {ArchiveListQuestion[]} */
  let allQuestions = [];
  if (subjects && Array.isArray(subjects)) {
    subjects.forEach(sub => {
      const subQs = questions[sub] || [];
      subQs.forEach((q, idx) => {
        allQuestions.push({
          ...q,
          subject: sub,
          displayNumber: idx + 1
        });
      });
    });
  } else {
    // Fallback if subjects array is not structured standardly
    Object.keys(questions).forEach(sub => {
      const subQs = questions[sub] || [];
      subQs.forEach((q, idx) => {
        allQuestions.push({
          ...q,
          subject: sub,
          displayNumber: idx + 1
        });
      });
    });
  }

  // Filter by subject and search term
  const filteredQuestions = allQuestions.filter(q => {
    const matchesSubject = selectedSubject === 'ALL' || q.subject === selectedSubject;
    const matchesSearch = !searchTerm || 
      (q.text && q.text.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (q.options && q.options.some(opt => opt && opt.toLowerCase().includes(searchTerm.toLowerCase())));
    return matchesSubject && matchesSearch;
  });

  const handleCopyAsText = () => {
    let textOutput = `=== ${exam.title} - Question Archive ===\n\n`;
    allQuestions.forEach((q, index) => {
      const isNumerical = (q.type || '').toUpperCase() === 'NUMERICAL' || (q.type || '').toUpperCase() === 'NAT' || !q.options || q.options.length === 0;
      textOutput += `Q${index + 1} [${q.subject}] (${isNumerical ? 'NUMERICAL' : 'MCQ'}): ${q.text || '(Image Question)'}\n`;
      if (isNumerical) {
        textOutput += `   [NUMERICAL ANSWER]: ${q.correctAnswer}\n`;
      } else if (q.options && Array.isArray(q.options)) {
        q.options.forEach((opt, optIdx) => {
          const letter = String.fromCharCode(65 + optIdx);
          const isCorrect = Number(q.correctAnswer) === optIdx;
          textOutput += `   ${letter}) ${opt || '(Image Option)'} ${isCorrect ? ' [CORRECT]' : ''}\n`;
        });
      }
      textOutput += '\n';
    });

    navigator.clipboard.writeText(textOutput).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    });
  };

  /** @param {boolean} active */
  const subjectTabClass = (active) => cn(
    'inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold transition-colors',
    active
      ? 'border-brand-600 bg-brand-600 text-white shadow-sm hover:bg-brand-700'
      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
  );

  return (
    <Card className="animate-fade-in mt-6">
      <CardHeader className="items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
            <FileText className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold tracking-tight text-slate-900">Exam Question Paper Archive</h3>
            <CardDescription className="mt-0.5">
              Reference of all {allQuestions.length} questions included in this exam session for auditing and verification.
            </CardDescription>
          </div>
        </div>

        <Button
          variant="secondary"
          onClick={handleCopyAsText}
          className={cn(copied && 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-50')}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? 'Copied to Clipboard!' : 'Copy Question Paper'}
        </Button>
      </CardHeader>

      <CardContent>
        {/* Subject Tabs and Search */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setSelectedSubject('ALL')} className={subjectTabClass(selectedSubject === 'ALL')} aria-pressed={selectedSubject === 'ALL'}>
              All Subjects <span className="tabular-nums opacity-80">({allQuestions.length})</span>
            </button>
            {subjects && subjects.map(sub => {
              const count = (questions[sub] || []).length;
              return (
                <button key={sub} type="button" onClick={() => setSelectedSubject(sub)} className={subjectTabClass(selectedSubject === sub)} aria-pressed={selectedSubject === sub}>
                  {sub} <span className="tabular-nums opacity-80">({count})</span>
                </button>
              );
            })}
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <Input
              type="text"
              aria-label="Search question prompt or option"
              placeholder="Search question prompt or option..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        {/* Questions List */}
        {filteredQuestions.length === 0 ? (
          <EmptyState icon={SearchX} title="No questions found matching your filter criteria." />
        ) : (
          <div className="flex max-h-[700px] flex-col gap-4 overflow-y-auto pr-1">
            {filteredQuestions.map((q, idx) => (
              <article
                key={`${q.subject}-${idx}-${q.id || 'noid'}`}
                className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">Question #{q.displayNumber}</span>
                  <Badge variant="brand" className="uppercase tracking-wide">{q.subject}</Badge>
                  <Badge variant={q.type === 'NUMERICAL' ? 'warning' : 'success'} className="uppercase tracking-wide">
                    {q.type === 'NUMERICAL' ? 'NUMERICAL VALUE TYPE' : 'MCQ'}
                  </Badge>
                </div>

                <div className="text-base font-medium leading-relaxed text-slate-900">
                  <MathRenderer text={q.text} />
                </div>

                {q.questionImageUrl && (
                  <div className="mt-1">
                    <StorageImage
                      src={q.questionImageUrl}
                      alt="Question Diagram"
                      className="max-h-[200px] max-w-full rounded-lg border border-slate-200 bg-white"
                    />
                  </div>
                )}

                {/* Options / Numerical Answer */}
                {q.type === 'NUMERICAL' || !q.options || q.options.length === 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                    <Hash className="size-4 shrink-0 text-amber-600" aria-hidden="true" />
                    <span>Correct Numerical Answer:</span>
                    <span className="rounded-md bg-amber-100 px-2.5 py-0.5 font-mono text-base text-amber-900 ring-1 ring-amber-200 tabular-nums">{q.correctAnswer}</span>
                  </div>
                ) : (
                  <div className="mt-1 grid gap-2.5 md:grid-cols-2">
                    {q.options && q.options.map((opt, optIdx) => {
                      const isCorrect = Number(q.correctAnswer) === optIdx;
                      const optImg = q.optionImageUrls && q.optionImageUrls[optIdx];
                      const letter = String.fromCharCode(65 + optIdx);

                      return (
                        <div
                          key={optIdx}
                          className={cn(
                            'flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3 text-sm',
                            isCorrect ? 'border-emerald-300 bg-emerald-50 ring-1 ring-emerald-200' : 'border-slate-200 bg-white'
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span
                              className={cn(
                                'grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold',
                                isCorrect ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'
                              )}
                            >
                              {letter}
                            </span>
                            <span className="min-w-0 text-slate-800">
                              <MathRenderer text={opt || '(Image Option)'} />
                            </span>
                          </div>

                          <div className="flex shrink-0 items-center gap-2">
                            {optImg && (
                              <StorageImage
                                src={optImg}
                                alt={`Option ${letter}`}
                                className="h-10 rounded border border-slate-200 bg-white"
                              />
                            )}
                            {isCorrect && (
                              <Badge variant="success" className="border-emerald-600 bg-emerald-600 text-white">
                                <CheckCircle2 aria-hidden="true" />
                                CORRECT
                              </Badge>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default ExamQuestionsArchive;
