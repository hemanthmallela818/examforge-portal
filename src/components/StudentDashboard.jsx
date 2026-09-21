import { useState, useEffect, useRef } from 'react';
import { supabase } from '../supabase';
import {
  sessionBelongsToStudent,
  clearOfflineRecoveryRecord,
  readPendingSubmissionRecord,
  beginPendingSubmissionSync,
  finishPendingSubmissionSync
} from '../examLogic';
import { fetchAllRows } from '../paginatedQuery';

const StudentDashboard = ({ student, onLogout, onStartExam, onViewResult }) => {
  const [exams, setExams] = useState([]);
  const [completedExams, setCompletedExams] = useState(new Set());
  const [completedResults, setCompletedResults] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingSubmissionExamId, setPendingSubmissionExamId] = useState(() => {
    return readPendingSubmissionRecord({ student, userUuid: student?.docId })?.examId || null;
  });
  const [isSyncingPending, setIsSyncingPending] = useState(false);
  const refreshTimer = useRef(null);

  const activeLocalSession = (() => {
    try {
      const raw = localStorage.getItem('cbt_active_exam_session');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!sessionBelongsToStudent(parsed, student)) {
        throw new Error('This saved submission belongs to a different student.');
      }
      if (sessionBelongsToStudent(parsed, student) && parsed?.activeExam && parsed?.endTime > Date.now()) return parsed;
    } catch {}
    return null;
  })();

  const syncPendingOfflineSubmission = async () => {
    if (!pendingSubmissionExamId) return;
    const parsed = readPendingSubmissionRecord({
      student,
      examId: pendingSubmissionExamId,
      userUuid: student?.docId
    });
    if (!parsed) {
      setPendingSubmissionExamId(null);
      return;
    }
    if (!beginPendingSubmissionSync({ student, examId: pendingSubmissionExamId, userUuid: student?.docId })) return;
    try {
      setIsSyncingPending(true);
      const { data: finalResults, error } = await supabase.rpc('submit_exam', {
        exam_id_param: pendingSubmissionExamId,
        responses_param: parsed.responses
      });
      if (error) {
        if (/already been submitted/i.test(error.message || '')) {
          const { data: committedResult } = await supabase
            .from('student_results')
            .select('*')
            .eq('student_id', student.id)
            .eq('exam_id', pendingSubmissionExamId)
            .single();
          if (committedResult) {
            clearOfflineRecoveryRecord({ student, examId: pendingSubmissionExamId });
            setPendingSubmissionExamId(null);
            if (onViewResult) {
              onViewResult({
                totalScore: committedResult.total_score,
                maxScore: committedResult.max_score,
                correct: committedResult.correct,
                incorrect: committedResult.incorrect,
                unattempted: committedResult.unattempted,
                subjectScores: committedResult.subject_scores
              });
            } else {
              await fetchExamsAndResults();
            }
            return;
          }
        }
        throw error;
      }
      clearOfflineRecoveryRecord({ student, examId: pendingSubmissionExamId });
      setPendingSubmissionExamId(null);
      if (onViewResult) {
        onViewResult(finalResults);
      } else {
        await fetchExamsAndResults();
      }
    } catch (err) {
      console.error("Offline submission sync error:", err);
      setError("Failed to sync offline submission. Please check connection and try again.");
    } finally {
      setIsSyncingPending(false);
      finishPendingSubmissionSync({ student, examId: pendingSubmissionExamId, userUuid: student?.docId });
    }
  };

  const fetchExamsAndResults = async () => {
    try {
      setError('');
      // 1. Fetch completed exam results for this student
      const resultsData = await fetchAllRows((from, to) => supabase
        .from('student_results')
        .select('exam_id, total_score, max_score, correct, incorrect, unattempted, subject_scores')
        .eq('student_id', student.id)
        .order('exam_id', { ascending: true })
        .range(from, to));
      const completedSet = new Set((resultsData || []).map(r => r.exam_id));
      const resultsMap = {};
      (resultsData || []).forEach(r => {
        resultsMap[r.exam_id] = {
          totalScore: r.total_score,
          maxScore: r.max_score,
          correct: r.correct,
          incorrect: r.incorrect,
          unattempted: r.unattempted,
          subjectScores: r.subject_scores
        };
      });
      setCompletedExams(completedSet);
      setCompletedResults(resultsMap);

      // 2. Fetch exams matching this student's class and section
      const studentClass = student.class || null;
      const studentSection = student.section || null;
      const examsData = await fetchAllRows((from, to) => supabase
        .from('cbt_exams')
        .select('id, title, status, class, section, created_at, questions_data')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to));
      
      const filteredExams = (examsData || []).filter(ex => {
        if (!ex.class || ex.class === 'All' || (studentClass && ex.class === studentClass)) {
          if (!ex.section || ex.section === 'All' || (studentSection && ex.section === studentSection)) {
            return true;
          }
        }
        return false;
      });

      setExams(filteredExams.map(ex => ({
        ...ex,
        questionsData: ex.questions_data
      })));

    } catch (err) {
      console.error("Failed to load dashboard data:", err);
      setError("Failed to fetch exams. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  const scheduleDashboardRefresh = () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      fetchExamsAndResults();
    }, 300);
  };

  useEffect(() => {
    if (!student) return;
    fetchExamsAndResults();

    // Raw papers never enter Realtime. The metadata-only event table is a fast
    // refresh signal; the protected view remains the authoritative read path.
    const examsChannel = supabase
      .channel(`student-exams-${student.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'exam_status_events' },
        (payload) => {
          const examObj = payload.new || payload.old;
          // Refresh if it matches the student's class and section
          if (examObj
            && (!examObj.class || examObj.class === 'All' || examObj.class === student.class)
            && (!examObj.section || examObj.section === 'All' || examObj.section === student.section)) {
            scheduleDashboardRefresh();
          }
        }
      )
      .subscribe();

    // Subscribe to student_results to update completed status dynamically
    const resultsChannel = supabase
      .channel(`student-results-${student.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'student_results' },
        (payload) => {
          const resultObj = payload.new || payload.old;
          if (resultObj && resultObj.student_id === student.id) {
            scheduleDashboardRefresh();
          }
        }
      )
      .subscribe();

    // Realtime is the fast path; polling is a safety net for school networks
    // that block WebSocket connections.
    const refreshInterval = setInterval(fetchExamsAndResults, 15000);

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      clearInterval(refreshInterval);
      supabase.removeChannel(examsChannel);
      supabase.removeChannel(resultsChannel);
    };
  // The subscription lifetime is bound to the authenticated student. Query
  // state is owned inside this component and refreshed by the callbacks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student]);

  const handleStartExam = (exam) => {
    onStartExam(exam);
  };

  return (
    <div className="student-dashboard-page" style={{ minHeight: '100vh', backgroundColor: 'var(--bg-color)', padding: '40px 20px' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
        
        {/* Header bar */}
        <div className="student-dashboard-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'var(--panel-bg)', padding: '20px 30px', borderRadius: '12px', border: '1px solid var(--border-color)', marginBottom: '24px', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
          <div>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Welcome back,</span>
            <h2 style={{ color: 'var(--text-main)', margin: '4px 0 0 0', fontSize: '1.6rem' }}>{student.name}</h2>
            <div className="student-account-meta" style={{ display: 'flex', gap: '15px', marginTop: '8px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              <span><strong>ID:</strong> {student.id}</span>
              <span><strong>Class:</strong> {student.class || 'Unassigned'}{student.section ? ` (${student.section})` : ''}</span>
            </div>
          </div>
          <button onClick={onLogout} className="btn-outline" style={{ padding: '8px 16px', fontSize: '0.9rem' }}>
            Logout
          </button>
        </div>

        {/* Exams List Container */}
        <div className="student-exams-panel" style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', border: '1px solid var(--border-color)', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
          <h3 style={{ margin: '0 0 20px 0', fontSize: '1.2rem', color: 'var(--text-main)' }}>Your Assigned Examinations</h3>

          {pendingSubmissionExamId && (
            <div className="student-recovery-banner" role="status" style={{
              backgroundColor: '#eff6ff',
              border: '2px solid #3b82f6',
              borderRadius: '8px',
              padding: '14px 20px',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '15px'
            }}>
              <div style={{ color: '#1e40af', fontSize: '0.95rem' }}>
                <strong>📡 Offline Exam Saved:</strong> You have an offline test attempt stored on this device. When online, click to synchronize your score to the server.
              </div>
              <button
                onClick={syncPendingOfflineSubmission}
                disabled={isSyncingPending}
                className="btn-primary"
                style={{ backgroundColor: '#2563eb', padding: '6px 14px', fontSize: '0.85rem', whiteSpace: 'nowrap' }}
              >
                {isSyncingPending ? 'Syncing...' : '🔄 Sync Score Now'}
              </button>
            </div>
          )}

          {error && (
            <div role="alert" style={{ padding: '12px', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: '6px', marginBottom: '20px', fontSize: '0.9rem' }}>
              <span>{error}</span>{' '}
              <button type="button" className="btn-outline" onClick={fetchExamsAndResults}>
                Retry dashboard
              </button>
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading examinations...</div>
          ) : exams.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)', backgroundColor: 'var(--bg-color)', borderRadius: '8px', border: '1px dashed var(--border-color)' }}>
              No exams have been assigned to your class and section yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {exams.map(exam => {
                const isCompleted = completedExams.has(exam.id);
                const isActive = exam.status === 'ACTIVE';
                const isPending = exam.status === 'PENDING';
                const isEnded = exam.status === 'ENDED';

                return (
                  <div className="student-exam-card" key={exam.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px', backgroundColor: 'var(--bg-color)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div>
                      <h4 style={{ margin: '0 0 6px 0', fontSize: '1.1rem', color: 'var(--text-main)' }}>{exam.title}</h4>
                      <div className="student-exam-meta" style={{ display: 'flex', gap: '15px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        <span>⏱️ {exam.questionsData?.duration || 180} Minutes</span>
                        <span>📚 {exam.questionsData?.subjects?.join(', ') || 'Physics, Chemistry, Maths'}</span>
                      </div>
                    </div>

                    <div>
                      {isCompleted ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span style={{ display: 'inline-block', padding: '8px 14px', borderRadius: '6px', backgroundColor: 'rgba(34, 197, 94, 0.1)', color: 'var(--success)', fontWeight: 'bold', fontSize: '0.9rem' }}>
                            ✅ Completed
                          </span>
                          {completedResults[exam.id] && onViewResult && (
                            <button
                              onClick={() => onViewResult(completedResults[exam.id])}
                              className="btn-outline"
                              style={{ padding: '7px 14px', fontSize: '0.85rem', fontWeight: 'bold' }}
                            >
                              📊 View Scorecard
                            </button>
                          )}
                        </div>
                      ) : isEnded ? (
                        <span style={{ display: 'inline-block', padding: '8px 16px', borderRadius: '6px', backgroundColor: 'rgba(100, 116, 139, 0.1)', color: 'var(--text-muted)', fontWeight: 'bold', fontSize: '0.9rem' }}>
                          🛑 Ended
                        </span>
                      ) : isPending ? (
                        <span style={{ display: 'inline-block', padding: '8px 16px', borderRadius: '6px', backgroundColor: 'rgba(245, 158, 11, 0.1)', color: '#d97706', fontWeight: 'bold', fontSize: '0.9rem', border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                          ⏳ Waiting for Admin to Start...
                        </span>
                      ) : isActive ? (
                        <button 
                          onClick={() => handleStartExam(exam)} 
                          className="btn-success" 
                          style={{ padding: '8px 20px', fontSize: '0.9rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px' }}
                        >
                          {activeLocalSession?.activeExam?.id === exam.id ? '🔄 Resume Exam' : '▶️ Start Exam'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StudentDashboard;
