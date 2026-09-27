'use client';

import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar } from 'recharts';

interface CostBreakdown {
  provider: string;
  compute: number;
  egress: number;
  storage: number;
  total: number;
}

export default function CostsPage() {
  const [dailyData] = useState([
    { date: '2026-09-20', cost: 12.5 },
    { date: '2026-09-21', cost: 15.2 },
    { date: '2026-09-22', cost: 14.8 },
    { date: '2026-09-23', cost: 16.3 },
    { date: '2026-09-24', cost: 13.9 },
    { date: '2026-09-25', cost: 17.1 },
    { date: '2026-09-26', cost: 14.6 },
  ]);

  const [breakdown] = useState<CostBreakdown[]>([
    { provider: 'AWS', compute: 65.4, egress: 28.3, storage: 5.2, total: 98.9 },
    { provider: 'Azure', compute: 35.2, egress: 12.5, storage: 2.1, total: 49.8 },
    { provider: 'Oracle', compute: 12.1, egress: 0, storage: 0.5, total: 12.6 },
  ]);

  const totalSpend = breakdown.reduce((sum, item) => sum + item.total, 0);
  const avgDailySpend = dailyData.reduce((sum, day) => sum + day.cost, 0) / dailyData.length;
  const projectedMonthly = avgDailySpend * 30;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-4xl font-bold neon-text mb-2 font-mono">[ COST_ANALYTICS ]</h1>
        <p className="font-mono text-neon-lime text-sm">
          {'> monitor_spending_across_providers'.toUpperCase()}
        </p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="neon-card-cyan rounded-lg p-6 border border-neon-cyan">
          <p className="text-xs text-neon-cyan/70 mb-2 font-mono font-bold">TOTAL_SPEND_MONTH</p>
          <p className="text-3xl font-bold text-neon-cyan font-mono">${totalSpend.toFixed(2)}</p>
          <p className="text-xs text-neon-cyan/50 mt-2 font-mono">thru_sept_26</p>
        </div>
        <div className="neon-card-magenta rounded-lg p-6 border border-neon-magenta">
          <p className="text-xs text-neon-magenta/70 mb-2 font-mono font-bold">DAILY_AVERAGE</p>
          <p className="text-3xl font-bold text-neon-magenta font-mono">${avgDailySpend.toFixed(2)}</p>
          <p className="text-xs text-neon-magenta/50 mt-2 font-mono">last_7_days</p>
        </div>
        <div className="neon-card-lime rounded-lg p-6 border border-neon-lime">
          <p className="text-xs text-neon-lime/70 mb-2 font-mono font-bold">PROJ_MONTHLY</p>
          <p className="text-3xl font-bold text-neon-lime font-mono">${projectedMonthly.toFixed(2)}</p>
          <p className="text-xs text-neon-lime/50 mt-2 font-mono">if_trend_continues</p>
        </div>
        <div className="neon-card rounded-lg p-6 border border-neon-cyan">
          <p className="text-xs text-neon-cyan/70 mb-2 font-mono font-bold">TOP_COST</p>
          <p className="text-3xl font-bold text-neon-pink font-mono">AWS</p>
          <p className="text-xs text-neon-cyan/50 mt-2 font-mono">${breakdown[0].total.toFixed(2)} ({(breakdown[0].total / totalSpend * 100).toFixed(0)}%)</p>
        </div>
      </div>

      {/* Daily Trend */}
      <div className="neon-card rounded-lg p-6 mb-8 border-2 border-neon-cyan">
        <h2 className="text-xl font-bold neon-text mb-4 font-mono">[ DAILY_TREND ]</h2>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={dailyData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0, 255, 255, 0.1)" />
            <XAxis dataKey="date" stroke="rgba(0, 255, 255, 0.3)" />
            <YAxis stroke="rgba(0, 255, 255, 0.3)" />
            <Tooltip formatter={(value) => `$${value.toFixed(2)}`} contentStyle={{ backgroundColor: '#0a0e27', border: '1px solid #00ffff' }} />
            <Legend />
            <Line
              type="monotone"
              dataKey="cost"
              stroke="#00ffff"
              name="Daily_Cost"
              dot={{ fill: '#00ffff', r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Provider Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="neon-card rounded-lg p-6 border-2 border-neon-magenta">
          <h2 className="text-xl font-bold neon-accent mb-4 font-mono">[ COST_BY_PROVIDER ]</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={breakdown}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 0, 255, 0.1)" />
              <XAxis dataKey="provider" stroke="rgba(255, 0, 255, 0.3)" />
              <YAxis stroke="rgba(255, 0, 255, 0.3)" />
              <Tooltip formatter={(value) => `$${value.toFixed(2)}`} contentStyle={{ backgroundColor: '#0a0e27', border: '1px solid #ff00ff' }} />
              <Legend />
              <Bar dataKey="compute" stackId="a" fill="#00ffff" name="Compute" />
              <Bar dataKey="egress" stackId="a" fill="#00ff41" name="Egress" />
              <Bar dataKey="storage" stackId="a" fill="#ff00ff" name="Storage" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="neon-card-lime rounded-lg p-6 border-2 border-neon-lime">
          <h2 className="text-xl font-bold neon-success mb-4 font-mono">[ BREAKDOWN ]</h2>
          <div className="space-y-4">
            {breakdown.map((item) => (
              <div key={item.provider} className="border-l-4 border-neon-cyan pl-4 py-2">
                <h3 className="font-bold text-neon-cyan font-mono">{item.provider}</h3>
                <div className="grid grid-cols-4 gap-2 mt-2 text-xs font-mono">
                  <div className="text-neon-lime">
                    <p className="text-neon-cyan/70">Compute</p>
                    <p className="font-bold">${item.compute.toFixed(2)}</p>
                  </div>
                  <div className="text-neon-lime">
                    <p className="text-neon-cyan/70">Egress</p>
                    <p className="font-bold">${item.egress.toFixed(2)}</p>
                  </div>
                  <div className="text-neon-lime">
                    <p className="text-neon-cyan/70">Storage</p>
                    <p className="font-bold">${item.storage.toFixed(2)}</p>
                  </div>
                  <div className="text-neon-magenta">
                    <p className="text-neon-cyan/70">Total</p>
                    <p className="font-bold text-lg">${item.total.toFixed(2)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Budget Settings */}
      <div className="neon-card rounded-lg border-2 border-neon-magenta p-6 mt-8">
        <h2 className="text-lg font-bold neon-accent mb-4 font-mono">[ BUDGET_SETTINGS ]</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-neon-cyan mb-2 font-mono">MONTHLY_CAP</label>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="1000"
                className="input-neon flex-1 px-4 py-2 rounded font-mono text-sm"
              />
              <button className="btn-neon-magenta">SET</button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold text-neon-cyan mb-2 font-mono">ALERT_THRESHOLD_%</label>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="80"
                className="input-neon flex-1 px-4 py-2 rounded font-mono text-sm"
              />
              <button className="btn-neon-lime">SET</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
