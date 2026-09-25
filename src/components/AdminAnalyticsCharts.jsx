import { BarChart3, PieChart as PieChartIcon } from 'lucide-react';
import {
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui';

// Palette: brand-600, emerald-600, amber-500, red-600, violet-600 (kept in sync with LEGEND_SWATCHES).
// CSS variables, so the charts follow the institution colour and the dark theme.
const COLORS = ['var(--color-brand-600)', 'var(--color-emerald-600)', 'var(--color-amber-500)', 'var(--color-red-600)', 'var(--color-violet-600)'];
const LEGEND_SWATCHES = ['bg-brand-600', 'bg-emerald-600', 'bg-amber-500', 'bg-red-600', 'bg-violet-600'];

const AXIS_COLOR = 'var(--color-slate-400)';
const GRID_COLOR = 'var(--color-slate-200)';
const AXIS_TICK = { fill: 'var(--color-slate-500)', fontSize: 12 };

const TOOLTIP_CONTENT_STYLE = {
  borderRadius: 10,
  border: '1px solid var(--color-slate-200)',
  backgroundColor: 'var(--color-white)',
  boxShadow: '0 10px 30px -10px rgb(15 23 42 / 0.25)',
  fontSize: 12,
  padding: '8px 12px'
};
const TOOLTIP_LABEL_STYLE = { color: 'var(--color-slate-900)', fontWeight: 600, marginBottom: 2 };
const TOOLTIP_ITEM_STYLE = { color: 'var(--color-slate-700)' };

/**
 * @param {{
 *   distribution: Array<{ name: string, count: unknown }>,
 *   subjectAverages: Array<{ name: string, score: unknown }>
 * }} props
 */
const AdminAnalyticsCharts = ({ distribution, subjectAverages }) => (
  <div className="grid gap-6 lg:grid-cols-2">
    <Card>
      <CardHeader>
        <CardTitle as="h4">
          <BarChart3 aria-hidden="true" />
          Score Distribution
        </CardTitle>
      </CardHeader>
      <CardContent className="h-80 pt-4">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={distribution} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" stroke={AXIS_COLOR} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_COLOR }} fontSize={12} />
            <YAxis stroke={AXIS_COLOR} tick={AXIS_TICK} tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
            <RechartsTooltip
              cursor={{ fill: 'color-mix(in oklab, var(--color-brand-600) 8%, transparent)' }}
              contentStyle={TOOLTIP_CONTENT_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              itemStyle={TOOLTIP_ITEM_STYLE}
            />
            <Bar dataKey="count" fill={COLORS[0]} radius={[6, 6, 0, 0]} maxBarSize={48} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>

    {subjectAverages.length > 0 && (
      <Card>
        <CardHeader>
          <CardTitle as="h4">
            <PieChartIcon aria-hidden="true" />
            Average by Subject
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={subjectAverages}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={88}
                  paddingAngle={3}
                  cornerRadius={4}
                  stroke="var(--color-white)"
                  strokeWidth={2}
                  dataKey="score"
                >
                  {subjectAverages.map((entry, index) => (
                    <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <RechartsTooltip contentStyle={TOOLTIP_CONTENT_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} itemStyle={TOOLTIP_ITEM_STYLE} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2">
            {subjectAverages.map((entry, index) => (
              <li key={entry.name} className="flex items-center gap-2 text-sm text-slate-600">
                <span aria-hidden="true" className={`size-2.5 rounded-full ${LEGEND_SWATCHES[index % LEGEND_SWATCHES.length]}`} />
                {entry.name}: <span className="font-semibold text-slate-900 tabular-nums">{/** @type {number | string} */ (entry.score)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    )}
  </div>
);

export default AdminAnalyticsCharts;
