import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { Alert, SectionHeader } from '../../../components/ui';
import { refreshBranding, useBranding } from '../../../branding/brandingStore';
import BrandingSettingsCard from './BrandingSettingsCard';

/**
 * Root-only Settings area (/admin/settings). Other administrators see a notice;
 * the server refuses their changes anyway (root_update_branding).
 * @param {{ isRootDeveloper: boolean }} props
 */
export default function SettingsView({ isRootDeveloper }) {
  const branding = useBranding();
  const [savedMessage, setSavedMessage] = useState('');

  useEffect(() => {
    if (isRootDeveloper) refreshBranding();
  }, [isRootDeveloper]);

  if (!isRootDeveloper) {
    return (
      <Alert variant="warning" role="alert" title="Settings are available to the root developer only.">
        Ask the root developer to change the institution branding.
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        icon={Settings}
        title="Institution settings"
        description="Changes apply to every user after their next page load; this browser updates immediately."
      />
      {savedMessage && <Alert variant="success" role="status">{savedMessage}</Alert>}
      <BrandingSettingsCard
        // Re-initialise the form from the saved values after every save.
        key={branding.updatedAt || 'defaults'}
        branding={branding}
        onSaved={setSavedMessage}
      />
    </div>
  );
}
