import React, { useEffect, useRef, useState } from 'react';
import {
  announcePolite,
  announceAssertive,
  registerAnnouncers,
  unregisterAnnouncers
} from '../accessibilityLogic';

export { announcePolite, announceAssertive };

const LiveAnnouncer = () => {
  const [politeMessage, setPoliteMessage] = useState('');
  const [assertiveMessage, setAssertiveMessage] = useState('');
  const politeTimerRef = useRef(null);
  const assertiveTimerRef = useRef(null);

  useEffect(() => {
    const polite = (msg) => {
      clearTimeout(politeTimerRef.current);
      setPoliteMessage('');
      // Small timeout ensures screen readers detect text replacement
      politeTimerRef.current = setTimeout(() => setPoliteMessage(msg), 50);
    };

    const assertive = (msg) => {
      clearTimeout(assertiveTimerRef.current);
      setAssertiveMessage('');
      assertiveTimerRef.current = setTimeout(() => setAssertiveMessage(msg), 50);
    };

    registerAnnouncers(polite, assertive);

    return () => {
      clearTimeout(politeTimerRef.current);
      clearTimeout(assertiveTimerRef.current);
      unregisterAnnouncers();
    };
  }, []);

  return (
    <div
      style={{
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: 0,
        margin: '-1px',
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        border: 0
      }}
    >
      <div
        id="sr-polite-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {politeMessage}
      </div>
      <div
        id="sr-assertive-announcer"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        {assertiveMessage}
      </div>
    </div>
  );
};

export default LiveAnnouncer;
