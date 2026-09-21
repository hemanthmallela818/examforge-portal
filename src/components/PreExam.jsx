import { useState, useEffect } from 'react';
import { supabase } from '../supabase';
import { checkBrowserCompatibility, isNarrowViewport } from '../runtimeConfig';

const PreExam = ({ startExam, activeExamId, duration = 180, marksCorrect = 4, marksIncorrect = -1, subjects = [] }) => {
  const [checked, setChecked] = useState(false);
  const [examStatus, setExamStatus] = useState('PENDING');
  const [statusError, setStatusError] = useState('');
  const [compatCheck] = useState(() => checkBrowserCompatibility());
  const [isMobileScreen, setIsMobileScreen] = useState(() => typeof window !== 'undefined' ? isNarrowViewport(window.innerWidth) : false);

  useEffect(() => {
    const updateViewport = () => setIsMobileScreen(isNarrowViewport(window.innerWidth));
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(() => {
    if (!activeExamId) return;

    const fetchInitialStatus = async () => {
      try {
        const { data, error } = await supabase
          .from('cbt_exams')
          .select('status')
          .eq('id', activeExamId)
          .single();
        
        if (error) throw error;
        if (data) {
          setExamStatus(data.status);
          setStatusError('');
        }
      } catch (err) {
        console.error("Failed to fetch exam status:", err);
        setStatusError('Unable to verify the exam status. Check your connection.');
      }
    };
    fetchInitialStatus();

    const channel = supabase
      .channel(`pre-exam-${activeExamId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'exam_status_events', filter: `exam_id=eq.${activeExamId}` },
        (payload) => {
          if (payload.new && payload.new.status) {
            setExamStatus(payload.new.status);
          }
        }
      )
      .subscribe();

    const refreshInterval = setInterval(fetchInitialStatus, 15000);

    return () => {
      clearInterval(refreshInterval);
      supabase.removeChannel(channel);
    };
  }, [activeExamId]);

  const isExamActive = examStatus === 'ACTIVE';

  return (
    <div className="pre-exam-page" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', backgroundColor: 'var(--bg-color)', padding: '20px' }}>
      <div className="animate-fade-in pre-exam-card" style={{ backgroundColor: 'var(--panel-bg)', padding: '40px', borderRadius: '12px', boxShadow: '0 10px 25px rgba(0,0,0,0.1)', maxWidth: '640px', width: '100%' }}>
        <h1 style={{ marginBottom: '20px', color: 'var(--primary)' }}>Exam Instructions</h1>
        {statusError && <p role="alert" style={{ color: 'var(--danger)', fontWeight: 'bold' }}>{statusError}</p>}

        {/* Browser & Device Compatibility Check */}
        <div role={compatCheck.compatible ? 'status' : 'alert'} style={{ marginBottom: '20px', padding: '12px 16px', borderRadius: '8px', backgroundColor: compatCheck.compatible ? '#f0fdf4' : '#fef2f2', border: `1px solid ${compatCheck.compatible ? '#86efac' : '#f87171'}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: compatCheck.compatible ? '#166534' : '#991b1b', fontWeight: 'bold', fontSize: '0.9rem' }}>
            <span>{compatCheck.compatible ? '✓' : '⚠️'}</span>
            <span>{compatCheck.compatible ? 'Browser & Device Verified: Offline recovery storage is working.' : 'This browser cannot safely start the exam.'}</span>
          </div>
          {!compatCheck.compatible && (
            <ul style={{ margin: '6px 0 0 0', paddingLeft: '20px', fontSize: '0.8rem', color: '#b91c1c' }}>
              {compatCheck.missingFeatures.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
        </div>

        {/* Mobile Device Advisory */}
        {isMobileScreen && (
          <div style={{ marginBottom: '20px', padding: '12px 16px', borderRadius: '8px', backgroundColor: '#eff6ff', border: '1px solid #93c5fd', color: '#1e40af', fontSize: '0.88rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', marginBottom: '4px' }}>
              <span>📱</span>
              <span>Mobile Device Detected</span>
            </div>
            <span>You can take the exam on this device. For optimal readability of complex mathematical formulas and question navigation, we recommend a tablet, desktop, or landscape mode.</span>
          </div>
        )}
        
        <div style={{ marginBottom: '30px', lineHeight: '1.6', color: 'var(--text-muted)' }}>
          <p>1. The exam duration is {duration} minutes.</p>
          <p>2. The exam sections are: {subjects.join(', ') || 'as listed in your exam'}.</p>
          <p>3. Each correct answer awards +{marksCorrect} marks. Each incorrect answer deducts {Math.abs(marksIncorrect)} mark{Math.abs(marksIncorrect) === 1 ? '' : 's'}.</p>
          <p>4. <strong>Security Warning:</strong> This exam requires fullscreen mode. Do not exit fullscreen, switch tabs, or use prohibited shortcuts. Repeated verified violations can terminate and finalize the attempt using your last server-confirmed answers.</p>
        </div>

        <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <input 
            type="checkbox" 
            id="agree" 
            checked={checked} 
            onChange={(e) => setChecked(e.target.checked)} 
            style={{ width: '18px', height: '18px', cursor: 'pointer' }}
          />
          <label htmlFor="agree" style={{ cursor: 'pointer', fontWeight: '500' }}>
            I have read and understood the instructions.
          </label>
        </div>

        <button 
          className={isExamActive ? "btn-primary" : "btn-secondary"} 
          disabled={!checked || !isExamActive || !compatCheck.compatible} 
          onClick={startExam}
          style={{ 
            width: '100%', 
            padding: '12px', 
            fontSize: '16px', 
            fontWeight: 'bold',
            opacity: (!checked || !isExamActive || !compatCheck.compatible) ? 0.6 : 1, 
            cursor: (!checked || !isExamActive || !compatCheck.compatible) ? 'not-allowed' : 'pointer',
            backgroundColor: isExamActive ? 'var(--primary)' : 'var(--text-muted)',
            color: 'white',
            border: 'none',
            borderRadius: '6px'
          }}
        >
          {!compatCheck.compatible ? 'Browser Storage Required to Start' : isExamActive ? 'Start Exam' : 'Waiting for Admin to Start...'}
        </button>
      </div>
    </div>
  );
};

export default PreExam;
