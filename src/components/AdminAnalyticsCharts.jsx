import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from 'recharts';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

const AdminAnalyticsCharts = ({ distribution, subjectAverages }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '30px' }}>
    <div style={{ flex: '1 1 400px', height: '300px' }}>
      <h4 style={{ textAlign: 'center', color: 'var(--text-main)', marginBottom: '15px' }}>Score Distribution</h4>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={distribution}>
          <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={12} />
          <YAxis stroke="var(--text-muted)" fontSize={12} allowDecimals={false} />
          <RechartsTooltip cursor={{ fill: 'rgba(0,0,0,0.05)' }} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 15px rgba(0,0,0,0.1)' }} />
          <Bar dataKey="count" fill="var(--primary)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>

    {subjectAverages.length > 0 && (
      <div style={{ flex: '1 1 300px', height: '300px' }}>
        <h4 style={{ textAlign: 'center', color: 'var(--text-main)', marginBottom: '15px' }}>Average by Subject</h4>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={subjectAverages} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="score">
              {subjectAverages.map((entry, index) => (
                <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <RechartsTooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 15px rgba(0,0,0,0.1)' }} />
          </PieChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '15px', marginTop: '10px', flexWrap: 'wrap' }}>
          {subjectAverages.map((entry, index) => (
            <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              <span aria-hidden="true" style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: COLORS[index % COLORS.length] }} />
              {entry.name}: {entry.score}
            </div>
          ))}
        </div>
      </div>
    )}
  </div>
);

export default AdminAnalyticsCharts;
