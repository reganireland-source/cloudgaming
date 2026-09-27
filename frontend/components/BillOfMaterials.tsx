'use client';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

interface BillOfMaterialsProps {
  machine: {
    id: string;
    instance_type: string;
    region: string;
    provider: string;
  };
  billOfMaterials: {
    compute: {
      component: string;
      quantity: number;
      unit: string;
      costPerUnit: number;
      total: number;
    };
    streaming: {
      resolution: string;
      fps: number;
      bitrate: string;
      gbPerHour: number;
      egressRate: number;
      costPerHour: number;
    };
    total: {
      costPerHour: number;
      costPerDay: number;
      costPerMonth: number;
    };
  };
}

export default function BillOfMaterials({ machine, billOfMaterials }: BillOfMaterialsProps) {
  const { compute, streaming, total } = billOfMaterials;

  const data = [
    { name: 'Compute', value: parseFloat(compute.total.toFixed(2)) },
    { name: 'Streaming', value: parseFloat(streaming.costPerHour.toFixed(2)) },
  ];

  const COLORS = ['#5fd7e0', '#d487e8'];

  return (
    <div className="w-full max-w-5xl mx-auto neon-card rounded-lg p-8 border border-neon-cyan/30">
      <div className="mb-8">
        <h2 className="text-sm tracking-label font-bold neon-text mb-2 font-mono">[ BILL_OF_MATERIALS ]</h2>
        <p className="font-mono text-neon-lime text-sm">
          {machine.provider.toUpperCase()} // {machine.instance_type} // {machine.region}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Compute Component */}
        <div className="neon-card-cyan rounded-lg p-6 border border-neon-cyan/30">
          <div className="flex items-center mb-4">
            <div className="w-3 h-3 bg-neon-cyan rounded-full mr-3 animate-pulse"></div>
            <h3 className="text-sm font-bold text-neon-cyan font-mono">COMPUTE</h3>
          </div>
          <p className="text-xs text-neon-lime mb-4 font-mono">{compute.component}</p>
          <div className="space-y-2 text-sm font-mono">
            <div className="flex justify-between">
              <span className="text-neon-cyan/70">Quantity:</span>
              <span className="text-neon-magenta">{compute.quantity} {compute.unit}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neon-cyan/70">Rate:</span>
              <span className="text-neon-magenta">${compute.costPerUnit.toFixed(2)}/hr</span>
            </div>
            <div className="pt-3 border-t border-neon-cyan/30">
              <div className="flex justify-between">
                <span className="text-neon-cyan font-bold">TOTAL:</span>
                <span className="text-2xl font-bold text-neon-cyan">${compute.total.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Streaming Component */}
        <div className="neon-card-magenta rounded-lg p-6 border border-neon-magenta/30">
          <div className="flex items-center mb-4">
            <div className="w-3 h-3 bg-neon-magenta rounded-full mr-3 animate-pulse"></div>
            <h3 className="text-sm font-bold text-neon-magenta font-mono">STREAMING</h3>
          </div>
          <p className="text-xs text-neon-cyan mb-4 font-mono">{streaming.resolution} @ {streaming.fps}fps</p>
          <div className="space-y-2 text-sm font-mono">
            <div className="flex justify-between">
              <span className="text-neon-magenta/70">Bitrate:</span>
              <span className="text-neon-cyan">{streaming.bitrate}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neon-magenta/70">Data:</span>
              <span className="text-neon-cyan">{streaming.gbPerHour.toFixed(1)} GB/hr</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neon-magenta/70">Egress:</span>
              <span className="text-neon-cyan">${streaming.egressRate.toFixed(3)}/GB</span>
            </div>
            <div className="pt-3 border-t border-neon-magenta/30">
              <div className="flex justify-between">
                <span className="text-neon-magenta font-bold">COST:</span>
                <span className="text-2xl font-bold text-neon-magenta">${streaming.costPerHour.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Total Component */}
        <div className="neon-card-lime rounded-lg p-6 border border-neon-lime/30">
          <div className="flex items-center mb-4">
            <div className="w-3 h-3 bg-neon-lime rounded-full mr-3 animate-pulse"></div>
            <h3 className="text-sm font-bold text-neon-lime font-mono">TOTAL_COST</h3>
          </div>
          <p className="text-xs text-neon-cyan mb-6 font-mono">aggregated_pricing</p>
          <div className="space-y-4 font-mono text-sm">
            <div className="flex justify-between items-center">
              <span className="text-neon-lime/70">Per Hour:</span>
              <span className="text-xl font-bold text-neon-lime">${total.costPerHour.toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-neon-lime/70">Per Day:</span>
              <span className="text-xl font-bold text-neon-lime">${total.costPerDay.toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-neon-lime/70">Per Month:</span>
              <span className="text-xl font-bold text-neon-lime">${total.costPerMonth.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Cost Distribution Chart */}
      <div className="neon-card rounded-lg p-6 border border-neon-cyan/30 mb-6">
        <h3 className="text-sm font-bold text-neon-cyan mb-6 font-mono">[ COST_DISTRIBUTION ]</h3>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({ name, value }) => `${name}: $${Number(value).toFixed(2)}`}
              outerRadius={100}
              fill="#8884d8"
              dataKey="value"
            >
              {data.map((_entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(value) => `$${Number(value).toFixed(2)}/hr`} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Breakdown Summary */}
      <div className="border border-neon-magenta/30 rounded-lg p-6 bg-magenta-950/10 font-mono text-sm text-neon-magenta">
        <p className="leading-relaxed">
          {'> '}Running this configuration costs <span className="font-bold text-neon-cyan">${total.costPerMonth.toFixed(2)}</span> monthly (continuous).
          Streaming egress comprises <span className="font-bold text-neon-magenta">{((streaming.costPerHour / total.costPerHour) * 100).toFixed(0)}%</span> of total cost.
        </p>
      </div>
    </div>
  );
}
