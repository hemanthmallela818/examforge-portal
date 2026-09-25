import { useId, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, BookOpen, Check, Clock, Copy, Layers, Lock, Pencil, Plus, Power, Scale, Shapes, Trash2, X
} from 'lucide-react';
import { supabase } from '../supabase';
import { customConfirm, showToast } from '../utils';
import { MAX_PATTERN_QUESTIONS, MAX_PATTERN_SECTIONS, validatePatternDraft } from '../examPatternLogic';
import AccessibleModal from './AccessibleModal';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EmptyState, Field, Input,
  LoadingBlock, Select, Textarea, cn
} from './ui';

const SUBJECT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} &().,/+'-]*$/u;

/**
 * @typedef {import('../types').SubjectCatalogEntry} Subject
 * @typedef {import('../types').ExamTemplateEntry} Template
 * @typedef {import('../types').PatternDraft & { id: string | null, isActive: boolean }} EditorDraft
 */

/** @param {Subject['usage'] | undefined} usage */
const usageTotal = usage => Number(usage?.questions || 0) + Number(usage?.templates || 0) + Number(usage?.exams || 0);
/** @param {unknown} value */
const formatMarks = value => (Number(value) > 0 ? `+${Number(value)}` : `${Number(value)}`);

/** @returns {EditorDraft} */
const emptyDraft = () => ({
  id: null,
  name: '',
  description: '',
  durationMinutes: 180,
  marksCorrect: 4,
  marksIncorrect: -1,
  isActive: true,
  sections: [{ subject: '', questionCount: 25 }]
});

/**
 * @param {import('../types').UntrustedInput} error Supabase/RPC error or thrown value.
 * @param {string} fallback
 * @returns {string}
 */
const readError = (error, fallback) => (error?.message ? error.message.replace(/^.*?ERROR:\s*/, '') : fallback);

/* ------------------------------------------------------------------------ */
/* Subjects                                                                 */
/* ------------------------------------------------------------------------ */
/** @param {{ subjects: Subject[], onChanged: () => unknown }} props */
const SubjectsPanel = ({ subjects, onChanged }) => {
  const addId = useId();
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState('');
  const [busyId, setBusyId] = useState(/** @type {string | null} */ (null));
  const [rowError, setRowError] = useState(/** @type {{ id: string | null, message: string }} */ ({ id: null, message: '' }));
  const [editing, setEditing] = useState(/** @type {{ id: string | null, name: string }} */ ({ id: null, name: '' }));

  /**
   * @param {string} id
   * @param {() => Promise<void>} task
   * @param {string} [successMessage]
   */
  const run = async (id, task, successMessage) => {
    setBusyId(id);
    setRowError({ id: null, message: '' });
    try {
      await task();
      if (successMessage) showToast(successMessage, 'success');
      await onChanged();
      return true;
    } catch (error) {
      setRowError({ id, message: readError(error, 'The change could not be saved.') });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  /** @param {import('react').FormEvent} event */
  const addSubject = async event => {
    event.preventDefault();
    const name = newName.trim().replace(/\s+/g, ' ');
    if (!name) { setAddError('Enter a subject name.'); return; }
    if (name.length > 60) { setAddError('Subject names can be at most 60 characters.'); return; }
    if (!SUBJECT_NAME_PATTERN.test(name)) {
      setAddError("Use letters, numbers, spaces and & ( ) . , / + ' - only, starting with a letter or number.");
      return;
    }
    if (subjects.some(subject => subject.name.toLowerCase() === name.toLowerCase())) {
      setAddError(`A subject named "${name}" already exists.`);
      return;
    }
    setAddError('');
    setBusyId('new');
    try {
      const { error } = await supabase.rpc('admin_save_subject', { subject_id_param: null, name_param: name, is_active_param: true });
      if (error) throw error;
      setNewName('');
      showToast(`Subject "${name}" added.`, 'success');
      await onChanged();
    } catch (error) {
      setAddError(readError(error, 'The subject could not be added.'));
    } finally {
      setBusyId(null);
    }
  };

  /** @param {Subject} subject */
  const saveRename = subject => {
    const name = editing.name.trim().replace(/\s+/g, ' ');
    if (!name || name === subject.name) { setEditing({ id: null, name: '' }); return; }
    if (!SUBJECT_NAME_PATTERN.test(name) || name.length > 60) {
      setRowError({ id: subject.id, message: "Use up to 60 letters, numbers, spaces and & ( ) . , / + ' - characters." });
      return;
    }
    run(subject.id, async () => {
      const { error } = await supabase.rpc('admin_save_subject', { subject_id_param: subject.id, name_param: name, is_active_param: subject.isActive });
      if (error) throw error;
      setEditing({ id: null, name: '' });
    }, `Subject renamed to "${name}".`);
  };

  /** @param {Subject} subject */
  const toggleActive = subject => run(subject.id, async () => {
    const { error } = await supabase.rpc('admin_save_subject', { subject_id_param: subject.id, name_param: subject.name, is_active_param: !subject.isActive });
    if (error) throw error;
  }, `Subject "${subject.name}" ${subject.isActive ? 'deactivated' : 'reactivated'}.`);

  /**
   * @param {number} index
   * @param {number} direction
   */
  const move = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= subjects.length) return;
    const ordered = subjects.map(subject => subject.id);
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    run(subjects[index].id, async () => {
      const { error } = await supabase.rpc('admin_reorder_subjects', { ordered_ids_param: ordered });
      if (error) throw error;
    });
  };

  /** @param {Subject} subject */
  const remove = async subject => {
    if (!await customConfirm(`Delete the subject "${subject.name}"? This cannot be undone.`)) return;
    run(subject.id, async () => {
      const { error } = await supabase.rpc('admin_delete_subject', { subject_id_param: subject.id });
      if (error) throw error;
    }, `Subject "${subject.name}" deleted.`);
  };

  const activeCount = subjects.filter(subject => subject.isActive).length;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle><BookOpen aria-hidden="true" /> Subjects</CardTitle>
          <CardDescription>
            Subjects available for questions and exams. The order here is the order students see in an exam.
          </CardDescription>
        </div>
        <Badge variant="brand">{activeCount} active · {subjects.length} total</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <form onSubmit={addSubject} className="flex flex-wrap items-end gap-3" noValidate>
          <Field label="New subject" htmlFor={addId} error={addError} className="min-w-[220px] flex-1">
            <Input
              id={addId}
              value={newName}
              maxLength={60}
              placeholder="e.g. Biology"
              aria-invalid={Boolean(addError)}
              onChange={event => { setNewName(event.target.value); if (addError) setAddError(''); }}
            />
          </Field>
          <Button type="submit" loading={busyId === 'new'}><Plus aria-hidden="true" /> Add subject</Button>
        </form>

        {subjects.length === 0 ? (
          <EmptyState icon={BookOpen} title="No subjects yet" description="Add the subjects your institution teaches, such as Physics or Biology." />
        ) : (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200" aria-label="Configured subjects">
            {subjects.map((subject, index) => {
              const inUse = usageTotal(subject.usage) > 0;
              const busy = busyId === subject.id;
              const isEditing = editing.id === subject.id;
              return (
                <li key={subject.id} className={cn('flex flex-col gap-2 px-4 py-3', !subject.isActive && 'bg-slate-50')}>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex flex-col">
                      <Button variant="ghost" size="icon" className="size-6" aria-label={`Move ${subject.name} up`} disabled={index === 0 || Boolean(busyId)} onClick={() => move(index, -1)}>
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-6" aria-label={`Move ${subject.name} down`} disabled={index === subjects.length - 1 || Boolean(busyId)} onClick={() => move(index, 1)}>
                        <ArrowDown aria-hidden="true" />
                      </Button>
                    </div>

                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            aria-label={`New name for ${subject.name}`}
                            value={editing.name}
                            maxLength={60}
                            autoFocus
                            className="h-9 max-w-xs"
                            onChange={event => setEditing({ id: subject.id, name: event.target.value })}
                            onKeyDown={event => {
                              if (event.key === 'Enter') { event.preventDefault(); saveRename(subject); }
                              if (event.key === 'Escape') setEditing({ id: null, name: '' });
                            }}
                          />
                          <Button size="sm" onClick={() => saveRename(subject)} loading={busy}><Check aria-hidden="true" /> Save</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing({ id: null, name: '' })}><X aria-hidden="true" /> Cancel</Button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn('font-semibold', subject.isActive ? 'text-slate-900' : 'text-slate-500')}>{subject.name}</span>
                          {!subject.isActive && <Badge variant="neutral">Inactive</Badge>}
                        </div>
                      )}
                      <p className="mt-1 text-xs text-slate-500">
                        {subject.usage?.questions || 0} question(s) · {subject.usage?.templates || 0} pattern(s) · {subject.usage?.exams || 0} exam(s)
                      </p>
                    </div>

                    {!isEditing && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={inUse || Boolean(busyId)}
                          title={inUse ? 'Subjects that are in use keep their name. Create a new subject instead.' : 'Rename'}
                          aria-label={`Rename ${subject.name}`}
                          onClick={() => setEditing({ id: subject.id, name: subject.name })}
                        >
                          {inUse ? <Lock aria-hidden="true" /> : <Pencil aria-hidden="true" />} Rename
                        </Button>
                        <Button
                          size="sm"
                          variant={subject.isActive ? 'secondary' : 'success'}
                          disabled={Boolean(busyId)}
                          loading={busy && !isEditing}
                          aria-label={`${subject.isActive ? 'Deactivate' : 'Reactivate'} ${subject.name}`}
                          onClick={() => toggleActive(subject)}
                        >
                          <Power aria-hidden="true" /> {subject.isActive ? 'Deactivate' : 'Reactivate'}
                        </Button>
                        <Button
                          size="icon"
                          variant="danger-outline"
                          disabled={inUse || Boolean(busyId)}
                          title={inUse ? 'Subjects that are in use cannot be deleted. Deactivate it instead.' : 'Delete subject'}
                          aria-label={`Delete ${subject.name}`}
                          onClick={() => remove(subject)}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                  </div>
                  {rowError.id === subject.id && (
                    <Alert variant="danger" role="alert">{rowError.message}</Alert>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <Alert variant="neutral">
          Deactivating a subject stops new questions and patterns from using it. Existing questions and exams keep working.
          Subjects that are already used cannot be renamed or deleted.
        </Alert>
      </CardContent>
    </Card>
  );
};

/* ------------------------------------------------------------------------ */
/* Pattern editor                                                           */
/* ------------------------------------------------------------------------ */
/** @param {{ initial: EditorDraft, subjects: Subject[], onClose: () => void, onSaved: () => unknown }} props */
const PatternEditor = ({ initial, subjects, onClose, onSaved }) => {
  const titleId = useId();
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  const { errors, total, name } = useMemo(() => validatePatternDraft(draft, subjects), [draft, subjects]);
  const activeSubjects = subjects.filter(subject => subject.isActive);
  const usedSubjects = new Set(draft.sections.map(section => section.subject.toLowerCase()).filter(Boolean));
  const canAddSection = draft.sections.length < MAX_PATTERN_SECTIONS && activeSubjects.some(subject => !usedSubjects.has(subject.name.toLowerCase()));

  /** @param {Partial<EditorDraft>} patch */
  const update = patch => { setDraft(prev => ({ ...prev, ...patch })); setServerError(''); };
  /**
   * @param {number} index
   * @param {Partial<import('../types').PatternSection>} patch
   */
  const updateSection = (index, patch) => update({ sections: draft.sections.map((section, i) => (i === index ? { ...section, ...patch } : section)) });

  /** @param {import('react').FormEvent} event */
  const save = async event => {
    event.preventDefault();
    setTouched(true);
    if (errors.length > 0) return;
    setSaving(true);
    try {
      const { error } = await supabase.rpc('admin_save_exam_template', {
        template_id_param: draft.id,
        name_param: name,
        description_param: draft.description.trim(),
        duration_minutes_param: Number(draft.durationMinutes),
        marks_correct_param: Number(draft.marksCorrect),
        marks_incorrect_param: Number(draft.marksIncorrect),
        sections_param: draft.sections.map(section => ({ subject: section.subject, questionCount: Number(section.questionCount) })),
        is_active_param: draft.isActive
      });
      if (error) throw error;
      showToast(`Pattern "${name}" saved.`, 'success');
      await onSaved();
      onClose();
    } catch (error) {
      setServerError(readError(error, 'The pattern could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const fieldIds = { name: `${titleId}-name`, description: `${titleId}-description`, duration: `${titleId}-duration`, correct: `${titleId}-correct`, incorrect: `${titleId}-incorrect` };

  return (
    <AccessibleModal labelledBy={titleId} onEscape={() => !saving && onClose()} maxWidth="720px">
      <form onSubmit={save} className="flex flex-col gap-5 text-left" noValidate>
        <div className="flex items-start gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 ring-1 ring-brand-100">
            <Shapes className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">{draft.id ? 'Edit exam pattern' : 'New exam pattern'}</h2>
            <p className="text-sm text-slate-500">A pattern pre-fills an exam&apos;s subjects, question counts, duration and marking.</p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Pattern name" htmlFor={fieldIds.name} className="sm:col-span-2">
            <Input id={fieldIds.name} value={draft.name} maxLength={80} placeholder="e.g. NEET Mock" onChange={event => update({ name: event.target.value })} />
          </Field>
          <Field label="Description (optional)" htmlFor={fieldIds.description} className="sm:col-span-2" hint={`${draft.description.length}/500`}>
            <Textarea id={fieldIds.description} value={draft.description} maxLength={500} className="min-h-16" onChange={event => update({ description: event.target.value })} />
          </Field>
          <Field label="Duration (minutes)" htmlFor={fieldIds.duration}>
            <Input id={fieldIds.duration} type="number" inputMode="numeric" min={1} max={600} step={1} value={draft.durationMinutes} onChange={event => update({ durationMinutes: event.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Correct answer" htmlFor={fieldIds.correct}>
              <Input id={fieldIds.correct} type="number" min={0.25} max={100} step={0.25} value={draft.marksCorrect} onChange={event => update({ marksCorrect: event.target.value })} />
            </Field>
            <Field label="Wrong answer" htmlFor={fieldIds.incorrect}>
              <Input id={fieldIds.incorrect} type="number" min={-100} max={0} step={0.25} value={draft.marksIncorrect} onChange={event => update({ marksIncorrect: event.target.value })} />
            </Field>
          </div>
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 flex w-full items-center justify-between text-sm font-semibold text-slate-700">
            <span>Subject sections (in exam order)</span>
            <span className="font-medium text-slate-500 tabular-nums">Total: {total} question(s)</span>
          </legend>
          {draft.sections.map((section, index) => {
            const known = subjects.find(subject => subject.name.toLowerCase() === section.subject.toLowerCase());
            return (
              <div key={index} className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                <span className="mb-2 grid size-6 place-items-center rounded-full bg-white text-xs font-bold text-slate-500 ring-1 ring-slate-200">{index + 1}</span>
                <Field label="Subject" htmlFor={`${titleId}-section-${index}`} className="min-w-[180px] flex-1">
                  <Select id={`${titleId}-section-${index}`} value={section.subject} onChange={event => updateSection(index, { subject: event.target.value })}>
                    <option value="">Choose a subject…</option>
                    {known && !known.isActive && <option value={known.name}>{known.name} (inactive)</option>}
                    {activeSubjects.map(subject => (
                      <option
                        key={subject.id}
                        value={subject.name}
                        disabled={usedSubjects.has(subject.name.toLowerCase()) && subject.name.toLowerCase() !== section.subject.toLowerCase()}
                      >
                        {subject.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Questions" htmlFor={`${titleId}-count-${index}`} className="w-28">
                  <Input id={`${titleId}-count-${index}`} type="number" inputMode="numeric" min={1} max={MAX_PATTERN_QUESTIONS} step={1} value={section.questionCount} onChange={event => updateSection(index, { questionCount: event.target.value })} />
                </Field>
                <div className="mb-0.5 flex gap-1">
                  <Button variant="ghost" size="icon" aria-label={`Move section ${index + 1} up`} disabled={index === 0} onClick={() => {
                    const next = [...draft.sections];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    update({ sections: next });
                  }}><ArrowUp aria-hidden="true" /></Button>
                  <Button variant="ghost" size="icon" aria-label={`Move section ${index + 1} down`} disabled={index === draft.sections.length - 1} onClick={() => {
                    const next = [...draft.sections];
                    [next[index + 1], next[index]] = [next[index], next[index + 1]];
                    update({ sections: next });
                  }}><ArrowDown aria-hidden="true" /></Button>
                  <Button variant="ghost" size="icon" aria-label={`Remove section ${index + 1}`} disabled={draft.sections.length === 1} onClick={() => update({ sections: draft.sections.filter((_, i) => i !== index) })}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </div>
            );
          })}
          <div>
            <Button variant="secondary" size="sm" disabled={!canAddSection} onClick={() => update({ sections: [...draft.sections, { subject: '', questionCount: 10 }] })}>
              <Plus aria-hidden="true" /> Add subject section
            </Button>
            {!canAddSection && draft.sections.length < MAX_PATTERN_SECTIONS && (
              <span className="ml-3 text-xs text-slate-500">Every active subject is already in this pattern.</span>
            )}
          </div>
        </fieldset>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <Checkbox checked={draft.isActive} onChange={event => update({ isActive: event.target.checked })} />
          Available when creating exams
        </label>

        {touched && errors.length > 0 && (
          <Alert variant="danger" title="Fix these before saving" role="alert">
            <ul className="list-disc pl-4">{errors.map(message => <li key={message}>{message}</li>)}</ul>
          </Alert>
        )}
        {serverError && <Alert variant="danger" role="alert">{serverError}</Alert>}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" loading={saving}><Check aria-hidden="true" /> Save pattern</Button>
        </div>
      </form>
    </AccessibleModal>
  );
};

/* ------------------------------------------------------------------------ */
/* Patterns                                                                 */
/* ------------------------------------------------------------------------ */
/** @param {{ templates: Template[], subjects: Subject[], onChanged: () => unknown }} props */
const PatternsPanel = ({ templates, subjects, onChanged }) => {
  const [editor, setEditor] = useState(/** @type {EditorDraft | null} */ (null));
  const [busyId, setBusyId] = useState(/** @type {string | null} */ (null));
  const [error, setError] = useState('');
  const hasActiveSubjects = subjects.some(subject => subject.isActive);

  const openNew = () => setEditor(emptyDraft());
  /**
   * @param {Template} template
   * @param {boolean} [copy]
   */
  const openEdit = (template, copy = false) => setEditor({
    id: copy ? null : template.id,
    name: copy ? `${template.name} (copy)`.slice(0, 80) : template.name,
    description: template.description || '',
    durationMinutes: template.durationMinutes,
    marksCorrect: Number(template.marksCorrect),
    marksIncorrect: Number(template.marksIncorrect),
    isActive: copy ? true : template.isActive,
    sections: template.sections.map(section => ({ subject: section.subject, questionCount: section.questionCount }))
  });

  /** @param {Template} template */
  const remove = async template => {
    if (!await customConfirm(`Delete the pattern "${template.name}"? Exams already created from it are not affected.`)) return;
    setBusyId(template.id);
    setError('');
    try {
      const { error: rpcError } = await supabase.rpc('admin_delete_exam_template', { template_id_param: template.id });
      if (rpcError) throw rpcError;
      showToast(`Pattern "${template.name}" deleted.`, 'success');
      await onChanged();
    } catch (err) {
      setError(readError(err, 'The pattern could not be deleted.'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle><Layers aria-hidden="true" /> Exam patterns</CardTitle>
          <CardDescription>Reusable structures such as JEE Main or a NEET mock. Choose one when creating an exam.</CardDescription>
        </div>
        <Button onClick={openNew} disabled={!hasActiveSubjects} title={hasActiveSubjects ? undefined : 'Add an active subject first'}>
          <Plus aria-hidden="true" /> New pattern
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert variant="danger" role="alert">{error}</Alert>}
        {templates.length === 0 ? (
          <EmptyState icon={Layers} title="No patterns yet" description="Create a pattern to pre-fill subjects, question counts, duration and marking when you build an exam." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {templates.map(template => {
              const unusable = /** @type {number} */ (template.inactiveSubjects?.length) > 0;
              return (
                <article key={template.id} className={cn('flex flex-col gap-3 rounded-xl border p-4', template.isActive ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-50')}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-slate-900">{template.name}</h3>
                      {template.description && <p className="mt-0.5 text-sm text-slate-500">{template.description}</p>}
                    </div>
                    {template.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="neutral">Hidden</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="brand"><Layers aria-hidden="true" /> {template.totalQuestions} questions</Badge>
                    <Badge variant="neutral"><Clock aria-hidden="true" /> {template.durationMinutes} min</Badge>
                    <Badge variant="neutral"><Scale aria-hidden="true" /> {formatMarks(template.marksCorrect)} / {formatMarks(template.marksIncorrect)}</Badge>
                  </div>
                  <ul className="flex flex-wrap gap-1.5" aria-label={`Sections of ${template.name}`}>
                    {template.sections.map(section => (
                      <li key={section.subject} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                        {section.subject} · {section.questionCount}
                      </li>
                    ))}
                  </ul>
                  {unusable && (
                    <Alert variant="warning" icon={AlertTriangle}>
                      Uses inactive subject(s): {/** @type {string[]} */ (template.inactiveSubjects).join(', ')}. It can&apos;t be used for new exams until you edit it.
                    </Alert>
                  )}
                  <div className="mt-auto flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                    <Button size="sm" variant="secondary" onClick={() => openEdit(template)}><Pencil aria-hidden="true" /> Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(template, true)} disabled={!hasActiveSubjects}><Copy aria-hidden="true" /> Duplicate</Button>
                    <Button size="sm" variant="danger-outline" loading={busyId === template.id} onClick={() => remove(template)} aria-label={`Delete pattern ${template.name}`}>
                      <Trash2 aria-hidden="true" /> Delete
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </CardContent>
      {editor && <PatternEditor initial={editor} subjects={subjects} onClose={() => setEditor(null)} onSaved={onChanged} />}
    </Card>
  );
};

/* ------------------------------------------------------------------------ */
/**
 * @param {{ subjects: Subject[], templates: Template[], loading: boolean, error?: string, onReload: () => unknown }} props
 */
const SubjectsAndPatternsView = ({ subjects, templates, loading, error, onReload }) => {
  if (loading && subjects.length === 0) return <LoadingBlock label="Loading subjects and patterns…" />;
  return (
    <div className="animate-fade-in flex flex-col gap-6">
      {error && (
        <Alert variant="danger" title="Subjects and patterns could not be loaded" action={<Button variant="secondary" size="sm" onClick={onReload}>Retry</Button>} role="alert">
          {error}
        </Alert>
      )}
      <SubjectsPanel subjects={subjects} onChanged={onReload} />
      <PatternsPanel templates={templates} subjects={subjects} onChanged={onReload} />
    </div>
  );
};

export default SubjectsAndPatternsView;
