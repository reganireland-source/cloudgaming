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
        <h1 className="text-4xl font-bold text-gray-900 mb-2">Cost Tracking</h1>
        <p className="text-gray-600">Monitor your spending across cloud providers</p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-lg shadow p-6">
          <p className="text-sm text-gray-600 mb-2">Total Spend (This Month)</p>
          <p className="text-3xl font-bold text-gray-900">${totalSpend.toFixed(2)}</p>
          <p className="text-xs text-gray-500 mt-2">Through Sept 26</p>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <p className="text-sm text-gray-600 mb-2">Daily Average</p>
          <p className="text-3xl font-bold text-blue-600">${avgDailySpend.toFixed(2)}</p>
          <p className="text-xs text-gray-500 mt-2">Last 7 days</p>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <p className="text-sm text-gray-600 mb-2">Projected Monthly</p>
          <p className="text-3xl font-bold text-orange-600">${projectedMonthly.toFixed(2)}</p>
          <p className="text-xs text-gray-500 mt-2">If trend continues</p>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <p className="text-sm text-gray-600 mb-2">Biggest Cost</p>
          <p className="text-3xl font-bold text-purple-600">AWS</p>
          <p className="text-xs text-gray-500 mt-2">${breakdown[0].total.toFixed(2)} ({(breakdown[0].total / totalSpend * 100).toFixed(0)}%)</p>
        </div>
      </div>

      {/* Daily Trend */}
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Daily Spending Trend</h2>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={dailyData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />
            <YAxis />
            <Tooltip formatter={(value) => `$${value.toFixed(2)}`} />
            <Legend />
            <Line
              type="monotone"
              dataKey="cost"
              stroke="#3b82f6"
              name="Daily Cost"
              dot={{ fill: '#3b82f6', r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Provider Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">Cost by Provider</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={breakdown}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="provider" />
              <YAxis />
              <Tooltip formatter={(value) => `$${value.toFixed(2)}`} />
              <Legend />
              <Bar dataKey="compute" stackId="a" fill="#3b82f6" name="Compute" />
              <Bar dataKey="egress" stackId="a" fill="#10b981" name="Egress" />
              <Bar dataKey="storage" stackId="a" fill="#f59e0b" name="Storage" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">Detailed Breakdown</h2>
          <div className="space-y-4">
            {breakdown.map((item) => (
              <div key={item.provider} className="border-l-4 border-blue-500 pl-4">
                <h3 className="font-semibold text-gray-900">{item.provider}</h3>
                <div className="grid grid-cols-4 gap-2 mt-2 text-sm">
                  <div>
                    <p className="text-gray-600">Compute</p>
                    <p className="font-medium">${item.compute.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Egress</p>
                    <p className="font-medium">${item.egress.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Storage</p>
                    <p className="font-medium">${item.storage.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Total</p>
                    <p className="font-bold text-lg">${item.total.toFixed(2)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Budget Settings */}
      <div className="bg-blue-50 rounded-lg border border-blue-200 p-6 mt-8">
        <h2 className="text-lg font-bold text-gray-900 mb-4">Budget Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Monthly Budget Cap</label>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="1000"
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
              <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium">
                Set
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Alert Threshold (%)</label>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="80"
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
              <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium">
                Set
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
