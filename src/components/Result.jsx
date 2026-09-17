import React from 'react';

const Result = ({ results, onBackToDashboard }) => {
  if (!results) return null;
  const { totalScore = 0, maxScore = 0, correct = 0, incorrect = 0, unattempted = 0, subjectScores = {} } = results;

  return (
    <div className="result-page" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', backgroundColor: 'var(--bg-color)', padding: '40px 20px' }}>
      <div className="animate-fade-in result-card" style={{ backgroundColor: 'var(--panel-bg)', padding: '40px', borderRadius: '12px', boxShadow: '0 10px 25px rgba(0,0,0,0.1)', maxWidth: '800px', width: '100%' }}>
        <h1 style={{ marginBottom: '30px', color: 'var(--primary)', textAlign: 'center', fontSize: '2rem' }}>Exam Results</h1>
        
        {/* Main Score Box */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '40px' }}>
          <div className="result-score" style={{ textAlign: 'center', padding: '30px', backgroundColor: 'var(--bg-color)', borderRadius: '12px', border: '2px solid var(--primary)', minWidth: '250px' }}>
            <h2 style={{ fontSize: '1.2rem', color: 'var(--text-muted)', marginBottom: '10px' }}>Total Score</h2>
            <div style={{ fontSize: '3rem', fontWeight: 'bold', color: 'var(--primary)' }}>
              {totalScore} <span style={{ fontSize: '1.5rem', color: 'var(--text-muted)' }}>/ {maxScore}</span>
            </div>
          </div>
        </div>

        {/* Overall Stats Grid */}
        <div className="result-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px', marginBottom: '40px' }}>
          <div style={{ padding: '20px', backgroundColor: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', borderLeft: '4px solid var(--success)' }}>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Correct Answers</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--success)' }}>{correct}</div>
          </div>
          <div style={{ padding: '20px', backgroundColor: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', borderLeft: '4px solid var(--danger)' }}>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Incorrect Answers</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--danger)' }}>{incorrect}</div>
          </div>
          <div style={{ padding: '20px', backgroundColor: 'rgba(100, 116, 139, 0.1)', borderRadius: '8px', borderLeft: '4px solid var(--text-muted)' }}>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Unattempted</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--text-main)' }}>{unattempted}</div>
          </div>
        </div>

        {/* Subject Breakdown */}
        <h3 style={{ marginBottom: '20px', fontSize: '1.2rem', fontWeight: 'bold', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>Subject-wise Breakdown</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginBottom: '30px' }}>
          {Object.entries(subjectScores).map(([subject, score]) => (
            <div key={subject} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px', backgroundColor: 'var(--bg-color)', borderRadius: '8px' }}>
              <span style={{ fontWeight: '600', fontSize: '1.1rem' }}>{subject}</span>
              <span style={{ fontWeight: 'bold', color: 'var(--primary)', fontSize: '1.1rem' }}>{score} Marks</span>
            </div>
          ))}
        </div>

        {onBackToDashboard && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button 
              onClick={onBackToDashboard}
              className="btn-primary" 
              style={{ padding: '14px 32px', fontSize: '1rem', fontWeight: 'bold' }}
            >
              ⬅️ Return to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Result;
