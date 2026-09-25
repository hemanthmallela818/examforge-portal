import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ImagePlus, Palette, RotateCcw, Save, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Field, Input, cn } from '../../../components/ui';
import { supabase } from '../../../supabase';
import { customConfirm } from '../../../utils';
import {
  AA_NORMAL_TEXT,
  BRAND_STEPS,
  DEFAULT_BRAND_COLOR,
  deriveBrandScale,
  describeBrandContrast,
  normalizeHexColor
} from '../../../branding/brandPalette';
import {
  BRANDING_BUCKET,
  DEFAULT_INSTITUTION_NAME,
  MAX_INSTITUTION_NAME_LENGTH,
  brandingLogoUrl,
  normalizeBranding,
  normalizeInstitutionName,
  setBranding
} from '../../../branding/brandingStore';
import { LOGO_ACCEPT, logoObjectName, reencodeLogo, validateLogoFile } from '../../../branding/logoProcessing';

/**
 * @typedef {{ status: 'current' | 'removed' }
 *   | { status: 'new', blob: Blob, type: string, extension: 'png' | 'webp', previewUrl: string }} LogoDraft
 */

/** @param {unknown} error */
const saveErrorMessage = (error) => {
  const { code, message } = /** @type {{ code?: string, message?: string }} */ (error || {});
  if (code === '42501') return 'Only the root developer can change the branding.';
  return message || 'The branding could not be saved.';
};

/** @param {{ label: string, ratio: number, threshold?: number }} props */
const ContrastRow = ({ label, ratio, threshold = AA_NORMAL_TEXT }) => {
  const passes = ratio >= threshold;
  return (
    <li className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-semibold tabular-nums text-slate-900">{ratio.toFixed(2)}:1</span>
        <Badge variant={passes ? 'success' : 'warning'}>
          {passes ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
          {passes ? 'AA pass' : 'Below AA'}
        </Badge>
      </span>
    </li>
  );
};

/**
 * Root-only Branding form: institution name, primary colour (live preview and
 * WCAG contrast check) and logo. Saved through root_update_branding().
 * @param {{
 *   branding: import('../../../branding/brandingStore').Branding,
 *   onSaved: (message: string) => void
 * }} props
 */
export default function BrandingSettingsCard({ branding, onSaved }) {
  const [name, setName] = useState(branding.institutionName || '');
  const [colorText, setColorText] = useState(branding.primaryColor || '');
  const [logo, setLogo] = useState(/** @type {LogoDraft} */ ({ status: 'current' }));
  const [logoError, setLogoError] = useState('');
  const [processingLogo, setProcessingLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const fileInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const baseId = useId();
  const ids = { name: `${baseId}-name`, color: `${baseId}-color`, picker: `${baseId}-picker`, logo: `${baseId}-logo`, contrast: `${baseId}-contrast` };

  const trimmedColor = colorText.trim();
  const color = normalizeHexColor(trimmedColor);
  const colorInvalid = trimmedColor !== '' && !color;
  const effectiveColor = color || DEFAULT_BRAND_COLOR;
  const scale = useMemo(() => deriveBrandScale(color), [color]);
  const contrast = useMemo(() => describeBrandContrast(color), [color]);
  const previewStyle = useMemo(
    () => /** @type {import('react').CSSProperties} */ (Object.fromEntries(BRAND_STEPS.map(step => [`--brand-${step}`, scale[step]]))),
    [scale]
  );
  const previewName = normalizeInstitutionName(name) || DEFAULT_INSTITUTION_NAME;
  const previewLogoUrl = logo.status === 'new' ? logo.previewUrl : logo.status === 'current' ? branding.logoUrl : null;

  // Release the object URL of a replaced or unmounted logo preview.
  useEffect(() => () => {
    if (logo.status === 'new') URL.revokeObjectURL(logo.previewUrl);
  }, [logo]);

  /** @param {import('react').ChangeEvent<HTMLInputElement>} event */
  const handleLogoChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setLogoError('');
    setProcessingLogo(true);
    try {
      const check = await validateLogoFile(file);
      if (!check.valid) {
        setLogoError(check.error);
        return;
      }
      const encoded = await reencodeLogo(file);
      setLogo({ status: 'new', ...encoded, previewUrl: URL.createObjectURL(encoded.blob) });
    } catch (error) {
      setLogoError(/** @type {Error} */ (error)?.message || 'The logo could not be processed.');
    } finally {
      setProcessingLogo(false);
    }
  };

  /** @param {{ reset?: boolean }} [options] */
  const save = async ({ reset = false } = {}) => {
    if (!reset && colorInvalid) return;
    setSaving(true);
    setSaveError('');
    /** @type {string | null} */
    let uploadedPath = null;
    try {
      /** @type {string | null} */
      let logoPath = !reset && logo.status === 'current' ? branding.logoPath : null;
      if (!reset && logo.status === 'new') {
        const objectName = logoObjectName(logo.extension);
        const { error } = await supabase.storage.from(BRANDING_BUCKET).upload(objectName, logo.blob, {
          contentType: logo.type,
          cacheControl: '3600',
          upsert: false
        });
        if (error) throw new Error(`The logo could not be uploaded: ${error.message}`);
        uploadedPath = objectName;
        logoPath = objectName;
      }
      const { data, error } = await supabase.rpc('root_update_branding', {
        institution_name_param: reset ? null : normalizeInstitutionName(name),
        primary_color_param: reset ? null : color,
        logo_path_param: logoPath
      });
      if (error) throw error;
      const saved = normalizeBranding(data);
      setBranding({ ...saved, logoUrl: brandingLogoUrl(supabase, saved.logoPath, saved.updatedAt) });
      // The replaced logo is no longer referenced; removing it is best effort.
      if (branding.logoPath && branding.logoPath !== saved.logoPath) {
        Promise.resolve(supabase.storage.from(BRANDING_BUCKET).remove([branding.logoPath])).catch(() => {});
      }
      onSaved(reset ? 'Branding was reset to the ExamForge defaults.' : 'Branding saved. The login page, dashboards and exam header now use it.');
    } catch (error) {
      if (uploadedPath) {
        Promise.resolve(supabase.storage.from(BRANDING_BUCKET).remove([uploadedPath])).catch(() => {});
      }
      setSaveError(saveErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    const confirmed = await customConfirm('Reset the institution name, colour and logo to the ExamForge defaults?');
    if (confirmed) await save({ reset: true });
  };

  return (
    <Card as="section" aria-labelledby={`${ids.name}-title`}>
      <CardHeader>
        <div>
          <CardTitle id={`${ids.name}-title`} as="h2"><Palette aria-hidden="true" /> Branding</CardTitle>
          <CardDescription>
            Institution name, colour and logo shown on the login page, the administrator sidebar, the student dashboard and the exam header.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <form
          id={`${ids.name}-form`}
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Field
            label="Institution name"
            htmlFor={ids.name}
            hint={`Up to ${MAX_INSTITUTION_NAME_LENGTH} characters. Leave empty to show "${DEFAULT_INSTITUTION_NAME}".`}
          >
            <Input
              id={ids.name}
              value={name}
              maxLength={MAX_INSTITUTION_NAME_LENGTH}
              autoComplete="organization"
              placeholder={DEFAULT_INSTITUTION_NAME}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field
            label="Primary colour"
            htmlFor={ids.color}
            error={colorInvalid ? 'Enter a colour as #RRGGBB, for example #0f766e.' : undefined}
            hint="Used for buttons, links, highlights and the exam header. Leave empty for the default blue."
          >
            <div className="flex flex-wrap items-center gap-3">
              <input
                id={ids.picker}
                type="color"
                aria-label="Pick primary colour"
                value={effectiveColor}
                onChange={(event) => setColorText(event.target.value)}
                className="h-10 w-14 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
              />
              <Input
                id={ids.color}
                value={colorText}
                placeholder={DEFAULT_BRAND_COLOR}
                spellCheck={false}
                aria-invalid={colorInvalid}
                aria-describedby={ids.contrast}
                onChange={(event) => setColorText(event.target.value)}
                className="w-36 font-mono"
              />
              <Button variant="ghost" size="sm" onClick={() => setColorText('')} disabled={!colorText}>
                Use default colour
              </Button>
            </div>
          </Field>

          <div id={ids.contrast} className="rounded-xl border border-slate-200 p-4">
            <p className="text-sm font-semibold text-slate-900">Contrast check (WCAG AA 4.5:1)</p>
            <ul className="mt-1 divide-y divide-slate-100">
              <ContrastRow label="White text on the colour (buttons)" ratio={contrast.onButton} />
              <ContrastRow label="Colour as text on white (links)" ratio={contrast.asLightText} />
              <ContrastRow label="Dark-theme accent text" ratio={contrast.asDarkText} />
            </ul>
            {!contrast.passesAA && (
              <Alert variant="warning" className="mt-3" role="status">
                Text on this colour does not meet WCAG AA contrast. Choose a darker, more saturated colour so buttons and links stay readable.
              </Alert>
            )}
            <div className="mt-4 grid grid-cols-11 overflow-hidden rounded-lg ring-1 ring-slate-200" aria-label="Generated brand scale" role="img">
              {BRAND_STEPS.map(step => (
                <span key={step} className="h-8" style={{ backgroundColor: scale[step] }} title={`brand-${step} ${scale[step]}`} />
              ))}
            </div>
          </div>

          <Field
            label="Logo"
            htmlFor={ids.logo}
            error={logoError || undefined}
            hint="PNG, JPEG or WebP up to 1 MB. SVG is not accepted. The logo is re-encoded as PNG and scaled to at most 512 px."
          >
            <div className="flex flex-wrap items-center gap-3">
              <div className="grid size-16 place-items-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-slate-50">
                {previewLogoUrl
                  ? <img src={previewLogoUrl} alt="Logo preview" className="max-h-14 max-w-14 object-contain" />
                  : <span className="text-xs text-slate-500">No logo</span>}
              </div>
              <input
                ref={fileInputRef}
                id={ids.logo}
                type="file"
                accept={LOGO_ACCEPT}
                className="sr-only"
                onChange={handleLogoChange}
              />
              <Button variant="secondary" onClick={() => fileInputRef.current?.click()} loading={processingLogo}>
                <ImagePlus aria-hidden="true" /> Upload logo
              </Button>
              <Button
                variant="danger-outline"
                onClick={() => {
                  setLogoError('');
                  setLogo({ status: 'removed' });
                }}
                disabled={!previewLogoUrl}
              >
                <Trash2 aria-hidden="true" /> Remove logo
              </Button>
            </div>
          </Field>
        </form>

        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold text-slate-900">Live preview</p>
          <div className="brand-scope overflow-hidden rounded-xl border border-slate-200" style={previewStyle} data-testid="branding-preview">
            <div className="theme-island flex items-center gap-3 bg-brand-700 px-4 py-3 text-white">
              {previewLogoUrl
                ? <img src={previewLogoUrl} alt="" className="size-9 rounded-lg bg-white object-contain p-0.5" />
                : <span className="grid size-9 place-items-center rounded-lg bg-white/15 text-sm font-bold" aria-hidden="true">{previewName.slice(0, 1)}</span>}
              <div className="min-w-0">
                <p className="truncate text-xs text-brand-100">{previewName}</p>
                <p className="truncate text-sm font-semibold">Exam header</p>
              </div>
            </div>
            <div className="flex flex-col gap-3 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" tabIndex={-1}>Primary action</Button>
                <Badge variant="brand">Brand badge</Badge>
              </div>
              <p className="text-sm text-slate-700">
                Text with a <span className="font-semibold text-brand-700 underline">brand link</span> and a
                <span className="font-semibold text-brand-600"> highlight</span>.
              </p>
              <Alert variant="info">Information message in the brand colour.</Alert>
            </div>
          </div>
        </div>
      </CardContent>

      {saveError && (
        <div className="px-6 pb-4">
          <Alert variant="danger" role="alert">{saveError}</Alert>
        </div>
      )}

      <CardFooter className={cn('justify-between')}>
        <Button variant="ghost" onClick={handleReset} disabled={saving}>
          <RotateCcw aria-hidden="true" /> Reset to defaults
        </Button>
        <Button type="submit" form={`${ids.name}-form`} loading={saving} disabled={colorInvalid || processingLogo}>
          <Save aria-hidden="true" /> Save branding
        </Button>
      </CardFooter>
    </Card>
  );
}
