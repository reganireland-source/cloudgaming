'use client';

import { PieChart, Pie, Cell, Legend, Tooltip, ResponsiveContainer } from 'recharts';

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

  const COLORS = ['#3b82f6', '#10b981'];

  const containerStyle = {
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  };

  return (
    <div className="w-full max-w-4xl mx-auto p-8 rounded-lg shadow-xl" style={containerStyle}>
      <div className="text-white mb-8">
        <h2 className="text-3xl font-bold mb-2">Bill of Materials</h2>
        <p className="text-purple-100">{machine.provider.toUpperCase()} · {machine.instance_type} · {machine.region}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Compute Component */}
        <div className="bg-white rounded-lg p-6 shadow-md">
          <div className="flex items-center mb-4">
            <div className="w-4 h-4 bg-blue-500 rounded mr-3"></div>
            <h3 className="text-lg font-semibold text-gray-800">Compute</h3>
          </div>
          <p className="text-sm text-gray-600 mb-3">{compute.component}</p>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Quantity:</span>
              <span className="font-medium">{compute.quantity} {compute.unit}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Rate:</span>
              <span className="font-medium">${compute.costPerUnit.toFixed(2)}/hr</span>
            </div>
            <div className="pt-2 border-t-2 border-gray-200">
              <div className="flex justify-between">
                <span className="font-semibold text-gray-800">Total:</span>
                <span className="text-xl font-bold text-blue-600">${compute.total.toFixed(2)}/hr</span>
              </div>
            </div>
          </div>
        </div>

        {/* Streaming Component */}
        <div className="bg-white rounded-lg p-6 shadow-md">
          <div className="flex items-center mb-4">
            <div className="w-4 h-4 bg-green-500 rounded mr-3"></div>
            <h3 className="text-lg font-semibold text-gray-800">Streaming</h3>
          </div>
          <p className="text-sm text-gray-600 mb-3">{streaming.resolution} @ {streaming.fps}fps</p>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Bitrate:</span>
              <span className="font-medium">{streaming.bitrate}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Data:</span>
              <span className="font-medium">{streaming.gbPerHour.toFixed(1)} GB/hr</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Egress:</span>
              <span className="font-medium">${streaming.egressRate.toFixed(3)}/GB</span>
            </div>
            <div className="pt-2 border-t-2 border-gray-200">
              <div className="flex justify-between">
                <span className="font-semibold text-gray-800">Cost:</span>
                <span className="text-xl font-bold text-green-600">${streaming.costPerHour.toFixed(2)}/hr</span>
              </div>
            </div>
          </div>
        </div>

        {/* Total Component */}
        <div className="bg-white rounded-lg p-6 shadow-md">
          <div className="flex items-center mb-4">
            <div className="w-4 h-4 bg-purple-500 rounded mr-3"></div>
            <h3 className="text-lg font-semibold text-gray-800">Total Cost</h3>
          </div>
          <p className="text-sm text-gray-600 mb-6">Aggregated pricing</p>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Per Hour:</span>
              <span className="text-2xl font-bold text-purple-600">${total.costPerHour.toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Per Day:</span>
              <span className="text-lg font-bold text-purple-500">${total.costPerDay.toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Per Month:</span>
              <span className="text-lg font-bold text-purple-500">${total.costPerMonth.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Cost Distribution Chart */}
      <div className="bg-white rounded-lg p-6 shadow-md">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">Cost Distribution</h3>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({ name, value }) => `${name}: $${value.toFixed(2)}/hr`}
              outerRadius={100}
              fill="#8884d8"
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(value) => `$${value.toFixed(2)}/hr`} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Breakdown Summary */}
      <div className="mt-6 bg-white bg-opacity-20 rounded-lg p-4 text-white">
        <p className="text-sm">
          Running this machine costs approximately <span className="font-bold">${total.costPerMonth.toFixed(2)}</span> per month
          if kept running continuously. Streaming is {((streaming.costPerHour / total.costPerHour) * 100).toFixed(0)}% of total cost.
        </p>
      </div>
    </div>
  );
}
