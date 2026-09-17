import React, { useEffect, useRef, useState } from 'react';
import { announceAssertive, announcePolite } from './LiveAnnouncer';
import { checkTimerMilestones } from '../accessibilityLogic';

const ExamNavbar = ({
  subjects,
  activeSubject,
  setActiveSubject,
  studentName,
  examTitle,
  duration = 180,
  paused = false,
  onTimeOut,
  timeLeft,
  autosaveStatus = 'SAVED'
}) => {
  const [networkStatus, setNetworkStatus] = useState({
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    effectiveType: typeof navigator !== 'undefined' ? navigator.connection?.effectiveType || 'unknown' : 'unknown',
    downlink: typeof navigator !== 'undefined' ? navigator.connection?.downlink || 0 : 0
  });

  const announcedMilestonesRef = useRef(new Set());
  const previousTimeRef = useRef(timeLeft);
  const prevAutosaveRef = useRef(autosaveStatus);

  // Screen-reader timer milestone announcements
  useEffect(() => {
    if (typeof timeLeft !== 'number' || paused) return;

    const triggered = checkTimerMilestones(timeLeft, announcedMilestonesRef.current, previousTimeRef.current);
    previousTimeRef.current = timeLeft;
    triggered.forEach(({ label }) => {
      announceAssertive(label);
    });
  }, [timeLeft, paused]);

  // Screen-reader autosave status announcements
  useEffect(() => {
    if (prevAutosaveRef.current !== autosaveStatus) {
      if (autosaveStatus === 'SAVED') {
        announcePolite('Response saved to server.');
      } else if (autosaveStatus === 'OFFLINE') {
        announcePolite('Response saved locally offline.');
      } else if (autosaveStatus === 'FAILED') {
        announceAssertive('Autosave failed. Check your network connection.');
      }
      prevAutosaveRef.current = autosaveStatus;
    }
  }, [autosaveStatus]);

  const getAutosaveIndicator = () => {
    switch (autosaveStatus) {
      case 'SAVING':
        return <span style={{ color: '#facc15' }} title="Saving responses to server...">⏳ Saving…</span>;
      case 'OFFLINE':
        return <span style={{ color: '#fb923c' }} title="Offline: Responses saved to local storage">💾 Saved Offline</span>;
      case 'RETRYING':
        return <span style={{ color: '#facc15' }} title="Retrying synchronization...">🔄 Retrying…</span>;
      case 'FAILED':
        return <span style={{ color: '#f87171' }} title="Autosave failed. Check connection.">⚠️ Save Failed</span>;
      case 'CONFLICT':
        return <span style={{ color: '#fb923c' }} title="Newer server-confirmed progress was kept.">⚠️ Server Copy Kept</span>;
      case 'LOCKED':
        return <span style={{ color: '#cbd5e1' }} title="The exam deadline has passed.">🔒 Answers Locked</span>;
      case 'SAVED':
      default:
        return <span style={{ color: '#4ade80' }} title="All responses saved to server">✓ Saved</span>;
    }
  };

  useEffect(() => {
    const handleOnline = () => {
      setNetworkStatus(prev => ({ ...prev, online: true }));
      announcePolite('Internet connection restored. You are online.');
    };
    const handleOffline = () => {
      setNetworkStatus(prev => ({ ...prev, online: false }));
      announceAssertive('Warning: Internet connection lost. You are offline. Responses will be saved locally.');
    };
    const handleConnectionChange = () => {
      setNetworkStatus(prev => ({
        ...prev,
        effectiveType: navigator.connection?.effectiveType || 'unknown',
        downlink: navigator.connection?.downlink || 0
      }));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    if (typeof navigator !== 'undefined' && navigator.connection) {
      navigator.connection.addEventListener('change', handleConnectionChange);
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (typeof navigator !== 'undefined' && navigator.connection) {
        navigator.connection.removeEventListener('change', handleConnectionChange);
      }
    };
  }, []);

  const formatTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const getNetworkIndicator = () => {
    if (!networkStatus.online) {
      return <span title="Offline" style={{ color: '#ef4444', display: 'flex', alignItems: 'center', gap: '5px' }}>📵 Offline</span>;
    }
    // Network is online
    let color = '#4ade80'; // Green (Good)
    let text = 'Good';
    if (networkStatus.effectiveType === '3g' || (networkStatus.downlink > 0 && networkStatus.downlink < 3)) {
      color = '#facc15'; // Yellow (Fair)
      text = 'Fair';
    } else if (networkStatus.effectiveType === '2g' || networkStatus.effectiveType === 'slow-2g') {
      color = '#fb923c'; // Orange (Weak)
      text = 'Weak';
    }
    
    return (
      <span title={`${networkStatus.effectiveType.toUpperCase()} - ~${networkStatus.downlink}Mbps`} style={{ color: color, display: 'flex', alignItems: 'center', gap: '5px' }}>
        📶 {text}
      </span>
    );
  };

  return (
    <div className="exam-navbar" style={{
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: 'var(--primary)',
      color: 'white',
      boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
    }}>
      {/* Top Header */}
      <div className="exam-navbar-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px 20px' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 'bold', margin: 0, marginBottom: '5px' }}>{examTitle || 'JEE Main CBT Mock Test'}</h2>
          {studentName && <div style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.8)' }}>Candidate: <span style={{fontWeight: 'bold', color: 'white'}}>{studentName}</span></div>}
        </div>
        <div className="exam-navbar-indicators" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div role="status" aria-live="polite" aria-atomic="true" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem', backgroundColor: 'rgba(0,0,0,0.2)', padding: '6px 12px', borderRadius: '4px', fontWeight: 'bold' }}>
            {getAutosaveIndicator()}
          </div>
          <div role="status" aria-live="polite" aria-atomic="true" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem', backgroundColor: 'rgba(0,0,0,0.2)', padding: '6px 12px', borderRadius: '4px', fontWeight: 'bold' }}>
            {getNetworkIndicator()}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '1.1rem', fontWeight: 'bold' }}>
            <span>{paused ? 'Timer Paused:' : 'Time Left:'}</span>
            <span role="timer" aria-label={`${formatTime(timeLeft)} remaining`} style={{ backgroundColor: 'rgba(0,0,0,0.2)', padding: '5px 10px', borderRadius: '4px' }}>
              {formatTime(timeLeft)}
            </span>
          </div>
        </div>
      </div>
      
      {/* Subject Tabs */}
      <div className="exam-subject-tabs" aria-label="Exam subjects" style={{ display: 'flex', backgroundColor: 'var(--primary-hover)', padding: '0 20px' }}>
        {subjects.map(sub => (
          <button
            key={sub}
            onClick={() => setActiveSubject(sub)}
            style={{
              padding: '12px 24px',
              backgroundColor: activeSubject === sub ? 'white' : 'transparent',
              color: activeSubject === sub ? 'var(--primary)' : 'white',
              borderBottom: activeSubject === sub ? '3px solid var(--primary)' : '3px solid transparent',
              borderRadius: '6px 6px 0 0',
              fontWeight: '600',
              fontSize: '1rem'
            }}
          >
            {sub}
          </button>
        ))}
      </div>
    </div>
  );
};

export default ExamNavbar;
