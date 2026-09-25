import { useEffect, useRef, useState } from 'react';
import { ImageOff, Lock, RotateCw } from 'lucide-react';
import { supabase } from '../supabase';
import { Button, Skeleton } from './ui';

/** @param {string | null | undefined} value */
const isDirectImage = (value) => /^data:image\/|^https?:\/\//i.test(value || '');

/** @typedef {{ url: string, expires: number }} SignedUrlEntry */

/** @type {Map<string, SignedUrlEntry>} */
const signedUrlCache = new Map();

/**
 * @param {string | null | undefined} src
 * @returns {string | null}
 */
export const getCachedSignedUrl = (src) => {
  if (!src) return null;
  if (isDirectImage(src)) return src;
  if (signedUrlCache.has(src)) {
    const cached = /** @type {SignedUrlEntry} */ (signedUrlCache.get(src));
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

/**
 * @param {string | null | undefined} src
 * @param {string | null | undefined} url
 */
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

/** @param {string} src */
const clearCachedSignedUrl = (src) => {
  signedUrlCache.delete(src);
  try {
    const raw = sessionStorage.getItem('cbt_img_cache');
    const parsed = raw ? JSON.parse(raw) : {};
    delete parsed[src];
    sessionStorage.setItem('cbt_img_cache', JSON.stringify(parsed));
  } catch {}
};

/**
 * Pre-fetches signed URLs for every storage-hosted diagram in a server paper.
 * @param {import('../types').UntrustedInput} examData
 */
export const preloadExamImages = async (examData) => {
  if (!examData?.questions) return;
  /** @type {Set<string>} */
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
        q.optionImageUrls.forEach((/** @type {string | null | undefined} */ optUrl) => {
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

/**
 * @param {Omit<import('react').ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src?: string | null }} props
 */
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
        className="my-1.5 inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800"
      >
        <Lock className="size-4 shrink-0 text-red-600" aria-hidden="true" />
        <span>Insecure HTTP image URL blocked for security.</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        role="img"
        aria-label={alt ? `Diagram unavailable: ${alt}` : 'Diagram unavailable - image failed to load'}
        className="my-2 inline-flex max-w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-red-300 bg-red-50/70 px-5 py-4 text-center text-sm text-red-800"
      >
        <div className="flex items-center gap-1.5 font-semibold">
          <ImageOff className="size-4 shrink-0 text-red-600" aria-hidden="true" />
          <span>Diagram unavailable</span>
        </div>
        <span className="text-xs text-red-700">Image could not be loaded from storage.</span>
        <Button
          variant="secondary"
          size="sm"
          className="mt-1"
          onClick={() => {
            retryRef.current = 0;
            setLoadError(false);
            clearCachedSignedUrl(/** @type {string} */ (src));
            setResolvedSrc(null);
            setRefreshKey(v => v + 1);
          }}
        >
          <RotateCw aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }

  if (!resolvedSrc) {
    if (!src) return null;
    return (
      <span role="status" aria-label="Loading image" className="my-1 inline-flex items-center justify-center">
        <Skeleton className="h-16 w-28 rounded-lg" />
      </span>
    );
  }

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
          clearCachedSignedUrl(/** @type {string} */ (src));
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
