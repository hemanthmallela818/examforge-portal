# ExamForge UI Design System

ExamForge uses **Tailwind CSS v4** with **shadcn/ui-style components** kept in our own code
(`src/components/ui/`), **Lucide** icons, and the self-hosted **Inter** variable font.
Every screen should be built from these pieces so the product looks and behaves the same everywhere.

## Principles

1. **Calm and professional.** Slate neutrals with one brand blue. Colour signals status, not decoration.
2. **No emoji.** Every icon is a Lucide icon (`lucide-react`), `aria-hidden="true"`, next to a text label.
   Icon-only buttons need an `aria-label`. Medals and ranks use styled numbers, not emoji.
3. **Consistent structure.** Pages are made of `Card`s with a `CardHeader` (title, description, actions)
   and `CardContent`. Page-level titles use `SectionHeader`.
4. **Accessible by default.** Visible focus rings, labelled inputs (`Field` + `htmlFor`), 44px touch targets
   on mobile, `role="status"` / `role="alert"` for live messages, and no information conveyed by colour alone.
5. **Responsive.** Use `flex-wrap`, `grid` with `sm:` / `md:` / `lg:` breakpoints. Nothing should need horizontal
   scrolling at 360px width except data tables, which scroll inside their own container.

## Tokens

| Purpose | Tailwind classes |
|---|---|
| Page background | `bg-slate-50` |
| Surface | `bg-white border border-slate-200 rounded-2xl shadow-card` (use `Card`) |
| Primary text / secondary text / hint | `text-slate-900` / `text-slate-600` / `text-slate-500` |
| Brand | `brand-50` … `brand-950` (brand-600 = `#2563eb`) |
| Success / warning / danger / review | `emerald-*` / `amber-*` / `red-*` / `violet-*` |
| Radius | inputs and buttons `rounded-lg`, cards `rounded-2xl`, pills `rounded-full` |
| Spacing | 4px grid: `gap-2`, `gap-3`, `gap-4`, `gap-6`; card padding `px-6 py-5` |
| Type | page title `text-2xl font-semibold tracking-tight`; card title `text-base font-semibold`; body `text-sm` |
| Numbers | add `tabular-nums` to scores, counts, timers |

## Components (`import { … } from './ui'` or `'../components/ui'`)

| Component | Use for |
|---|---|
| `Button` (`variant`: primary, secondary, ghost, success, warning, danger, danger-outline, violet, link; `size`: sm, md, lg, icon; `loading`) | Every button |
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | Every panel |
| `Badge` (`variant`: neutral, brand, success, warning, danger, violet, solid) | Status chips, counts, tags |
| `Alert` (`variant`: info, success, warning, danger, neutral; `title`; `action`) | Inline messages, errors with Retry |
| `Input`, `Textarea`, `Select`, `Checkbox`, `Label`, `Field` | Forms |
| `Table`, `THead`, `TBody`, `TR`, `TH`, `TD` | Data tables |
| `EmptyState`, `LoadingBlock`, `Spinner`, `Skeleton` | Empty, loading states |
| `SectionHeader`, `StatCard`, `MetaList` | Page headings, KPI tiles, label/value lists |
| `cn()` | Merging class names |

## Status colours in the exam (JEE / NTA convention)

| State | Style |
|---|---|
| Not visited | white / slate border |
| Not answered | red (`bg-red-500 text-white`) |
| Answered | green (`bg-emerald-500 text-white`) |
| Marked for review | violet (`bg-violet-600 text-white`) |
| Answered and marked | violet with a green dot |

## Rules that protect existing behaviour

- Do not change logic, data fetching, RPC or Edge Function calls, state handling or security behaviour.
  This is a presentation-only revamp.
- Keep every user-visible label, button name, heading, `title` and `aria-*` text that tests or
  Playwright use (grep `tests/` and `e2e/` before renaming anything).
- Keep these exact attributes because tests assert them literally:
  `className="active-exam-content"`, `className="admin-dashboard-shell"`,
  `className="exam-grid-panel" aria-label="Question navigator"`, `className="exam-navbar-indicators"`,
  `className="exam-navigation-actions"`, `className="exam-question-panel"`,
  `className="exam-security-cover"`, `className="result-stats"`, `className="student-exam-card"`,
  `className="student-recovery-banner" role="status"`. Put Tailwind classes on a child wrapper instead.
- Keep `.admin-exam-card`, `.student-exam-card`, `.status-answered` and similar classes that Playwright selects.

## Theming: dark mode and institution branding (U3)

### Theme preference

- **Light / Dark / System**, stored per browser in `localStorage` (`examforge.theme`, via `safeStorage*`).
  System follows `prefers-color-scheme` and updates live when the OS setting changes.
- `src/theme/theme.js` applies the resolved theme as a `dark` class, `data-theme` and `color-scheme` on `<html>`.
  `initTheme()` runs in `src/main.jsx` before React renders (a module, not an inline script, so the CSP keeps
  `script-src 'self'`). Until it runs, `index.css` follows the system setting for the page background.
- Controls: `ThemeToggle` (`src/theme/ThemeToggle.jsx`, a `radiogroup` labelled "Colour theme" with `radio` options
  and `aria-checked`) on the login page, the student dashboard and the exam header; the admin role chip
  (`AdminProfileMenu`) opens a menu with `menuitemradio` options. In the exam the toggle is **buttons only**
  (`arrowKeys={false}`): arrow keys there move between questions and no shortcut may reach the lockdown.

### How dark mode works (no per-component `dark:` classes)

`index.css` remaps the Tailwind colour variables under `.dark`, so existing utilities render dark:

| Tokens | Dark theme |
|---|---|
| `slate-50…900` | inverted: `slate-50` page `#0b1120`, `white` surface `#131c2e`, `slate-100` muted, `slate-200/300` borders, `slate-500…900` text |
| `white` | the card surface (`bg-white`); `text-white` is restored to real white |
| `slate-950` | unchanged (overlays, backdrops) |
| hue tints `-50…-300` (`red`, `amber`, `emerald`, `violet`, `orange`, `rose`, `brand`) | translucent tints of the hue over the surface (alert/badge backgrounds, borders, rings) |
| hue text `-500…-900` | lightened by class overrides (`text-red-700` → red-300, `text-brand-600` → brand-300, …) |
| solid `-400…-950` backgrounds | unchanged, so white text on buttons and the exam header keeps its contrast |

- **Islands.** Elements that look the same in both themes (admin sidebar, exam header, offline banner, score banner,
  termination overlay, code blocks) carry `theme-island`, which restores the light palette inside them.
  Add it to any new always-dark or always-coloured bar.
- **Explicit overrides.** Use `dark:` (declared with `@custom-variant dark`) only where remapping cannot express the
  intent. Charts use CSS variables (`var(--color-slate-400)`, `var(--color-brand-600)`) instead of hex values.
- **Exam palette.** The NTA status colours (`.status-*`) are fixed and stay distinguishable in both themes;
  their white text keeps AA contrast.
- **New code:** keep using the token classes above; do not hard-code hex colours or `white` in inline styles
  (use `var(--panel-bg)`, `var(--color-…)`).

### Institution branding

- Root developer only: **Settings → Branding** (`/admin/settings`). Institution name (1–80 characters), primary colour
  (`#RRGGBB`, live preview, WCAG AA contrast check) and logo (PNG/JPEG/WebP up to 1 MB, SVG rejected; re-encoded to
  PNG/WebP, max 512 px). **Reset to defaults** clears all three.
- Server: `institution_branding` singleton (no direct grants), `get_public_branding()` for anon and authenticated
  (name, colour, logo path/URL only), `root_update_branding(name, colour, logo_path)` (root only, audited as
  `UPDATE_BRANDING`). Logos live in the public `branding` bucket (the login page is anonymous); only the root
  developer can upload or delete, and the bucket cannot be listed.
- Client: `src/branding/brandingStore.js` caches the branding in `sessionStorage` and applies it in `main.jsx` before
  render, then refreshes it from the server. The colour becomes `brand-600`; `brandPalette.js` derives the whole
  `brand-50…950` scale in OKLCH and sets `--brand-*` on `<html>`. Unset or invalid colours fall back to the default blue.
- Shown on: login page (logo, name above "Exam Portal"), admin sidebar brand block, student dashboard brand bar and
  exam header. Use `BrandLogo` and `useBranding().displayName` (falls back to "ExamForge").
