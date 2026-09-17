import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase';

const isDirectImage = (value) => /^data:image\/|^https?:\/\//i.test(value || '');

const signedUrlCache = new Map();

export const getCachedSignedUrl = (src) => {
  if (!src) return null;
  if (isDirectImage(src)) return src;
  if (signedUrlCache.has(src)) {
    const cached = signedUrlCache.get(src);
    if (cached.expires > Date.now()) return cached.url;
    signedUrlCache.delete(src);
  }
  try {
    const raw = sessionStorage.getItem('cbt_img_cache');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed[src] && parsed[src].expires > Date.now()) {
        signedUrlCache.set(src, parsed[src]);
        return parsed[src].url;
      }
    }
  } catch {}
  return null;
};

export const setCachedSignedUrl = (src, url) => {
  if (!src || !url) return;
  const entry = { url, expires: Date.now() + 55 * 60 * 1000 };
  signedUrlCache.set(src, entry);
  try {
    const raw = sessionStorage.getItem('cbt_img_cache');
    const parsed = raw ? JSON.parse(raw) : {};
    parsed[src] = entry;
    sessionStorage.setItem('cbt_img_cache', JSON.stringify(parsed));
  } catch {}
};

const clearCachedSignedUrl = (src) => {
  signedUrlCache.delete(src);
  try {
    const raw = sessionStorage.getItem('cbt_img_cache');
    const parsed = raw ? JSON.parse(raw) : {};
    delete parsed[src];
    sessionStorage.setItem('cbt_img_cache', JSON.stringify(parsed));
  } catch {}
};

export const preloadExamImages = async (examData) => {
  if (!examData?.questions) return;
  const pathsToFetch = new Set();

  Object.values(examData.questions).forEach(subQuestions => {
    if (!Array.isArray(subQuestions)) return;
    subQuestions.forEach(q => {
      if (q.questionImageUrl && !isDirectImage(q.questionImageUrl) && !getCachedSignedUrl(q.questionImageUrl)) {
        pathsToFetch.add(q.questionImageUrl);
      }
      if (q.imageUrl && !isDirectImage(q.imageUrl) && !getCachedSignedUrl(q.imageUrl)) {
        pathsToFetch.add(q.imageUrl);
      }
      if (Array.isArray(q.optionImageUrls)) {
        q.optionImageUrls.forEach(optUrl => {
          if (optUrl && !isDirectImage(optUrl) && !getCachedSignedUrl(optUrl)) {
            pathsToFetch.add(optUrl);
          }
        });
      }
    });
  });

  if (pathsToFetch.size === 0) return;

  await Promise.allSettled(
    Array.from(pathsToFetch).map(async (path) => {
      try {
        const { data, error } = await supabase.storage.from('exam-assets').createSignedUrl(path, 60 * 60);
        if (!error && data?.signedUrl) {
          setCachedSignedUrl(path, data.signedUrl);
          // Preload into browser image memory
          const img = new Image();
          img.src = data.signedUrl;
        }
      } catch (err) {
        console.warn('Could not pre-fetch signed image:', path, err);
      }
    })
  );
};

const StorageImage = ({ src, alt, onError, onLoad, ...props }) => {
  const [resolvedSrc, setResolvedSrc] = useState(() => getCachedSignedUrl(src));
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    let active = true;
    if (!src) {
      setResolvedSrc(null);
      setLoadError(false);
      return undefined;
    }

    // Insecure HTTP check
    if (src.startsWith('http://')) {
      setResolvedSrc(null);
      setLoadError(false);
      return undefined;
    }

    if (isDirectImage(src)) {
      setResolvedSrc(src);
      setLoadError(false);
      return undefined;
    }

    const cached = getCachedSignedUrl(src);
    if (cached) {
      setResolvedSrc(cached);
      setLoadError(false);
      return undefined;
    }

    setResolvedSrc(null);
    setLoadError(false);

    supabase.storage.from('exam-assets').createSignedUrl(src, 60 * 60)
      .then(({ data, error }) => {
        if (!active) return;
        if (error || !data?.signedUrl) {
          console.warn('Could not create signed URL for image:', src, error);
          setLoadError(true);
        } else {
          setCachedSignedUrl(src, data.signedUrl);
          setResolvedSrc(data.signedUrl);
          setLoadError(false);
        }
      })
      .catch((err) => {
        if (active) {
          console.warn('StorageImage network error:', err);
          setLoadError(true);
        }
      });

    return () => { active = false; };
  }, [src, refreshKey]);

  if (src && src.startsWith('http://')) {
    return (
      <div
        role="alert"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderRadius: '6px',
          backgroundColor: '#fef2f2',
          border: '1px solid #f87171',
          color: '#991b1b',
          fontSize: '0.8rem',
          margin: '6px 0'
        }}
      >
        <span>🔒</span>
        <span>Insecure HTTP image URL blocked for security.</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        role="img"
        aria-label={alt ? `Diagram unavailable: ${alt}` : 'Diagram unavailable - image failed to load'}
        style={{
          display: 'inline-flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '14px 18px',
          borderRadius: '8px',
          border: '1px dashed #ef4444',
          backgroundColor: '#fef2f2',
          color: '#991b1b',
          fontSize: '0.85rem',
          gap: '6px',
          margin: '8px 0',
          maxWidth: '100%'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
          <span>⚠️</span>
          <span>Diagram unavailable</span>
        </div>
        <span style={{ fontSize: '0.75rem', color: '#b91c1c' }}>Image could not be loaded from storage.</span>
        <button
          type="button"
          onClick={() => {
            retryRef.current = 0;
            setLoadError(false);
            clearCachedSignedUrl(src);
            setResolvedSrc(null);
            setRefreshKey(v => v + 1);
          }}
          style={{
            marginTop: '4px',
            padding: '4px 10px',
            fontSize: '0.75rem',
            fontWeight: 'bold',
            backgroundColor: '#ffffff',
            border: '1px solid #dc2626',
            borderRadius: '4px',
            color: '#b91c1c',
            cursor: 'pointer'
          }}
        >
          🔄 Retry Loading
        </button>
      </div>
    );
  }

  if (!resolvedSrc) return null;

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      onLoad={(event) => {
        retryRef.current = 0;
        setLoadError(false);
        onLoad?.(event);
      }}
      onError={(event) => {
        onError?.(event);
        if (!isDirectImage(src) && retryRef.current < 2) {
          retryRef.current += 1;
          clearCachedSignedUrl(src);
          setResolvedSrc(null);
          setRefreshKey(value => value + 1);
        } else {
          setLoadError(true);
        }
      }}
      {...props}
    />
  );
};

export default StorageImage;
