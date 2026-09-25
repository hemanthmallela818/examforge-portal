import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { cn } from '../components/ui/cn';
import { useBranding } from './brandingStore';

/**
 * The institution logo, or the default graduation-cap mark in a brand tile.
 * Decorative: the institution name is always shown as text next to it.
 * @param {{ className?: string, imageClassName?: string, tileClassName?: string, iconClassName?: string }} props
 *   `className` applies to both; `imageClassName` to the uploaded logo and
 *   `tileClassName` to the fallback tile.
 */
export default function BrandLogo({ className, imageClassName, tileClassName, iconClassName }) {
  const { logoUrl } = useBranding();
  const [failedUrl, setFailedUrl] = useState(/** @type {string | null} */ (null));

  if (logoUrl && failedUrl !== logoUrl) {
    return (
      <img
        src={logoUrl}
        alt=""
        aria-hidden="true"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(logoUrl)}
        className={cn('brand-logo shrink-0 object-contain', className, imageClassName)}
      />
    );
  }
  return (
    <div className={cn('grid shrink-0 place-items-center', className, tileClassName)} aria-hidden="true">
      <GraduationCap className={iconClassName} />
    </div>
  );
}
