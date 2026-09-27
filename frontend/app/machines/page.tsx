'use client';

import { useState, useEffect } from 'react';

interface Machine {
  id: string;
  instance_type: string;
  region: string;
  provider: string;
  status: string;
  cost_per_hour: number;
  created_at?: string;
  ip_address?: string;
}

export default function MachinesPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Mock data for demonstration
    const mockMachines: Machine[] = [
      {
        id: '1',
        instance_type: 'g4dn.xlarge',
        region: 'us-east-1',
        provider: 'aws',
        status: 'running',
        cost_per_hour: 0.526,
        created_at: '2026-09-25',
        ip_address: '54.123.45.67',
      },
      {
        id: '2',
        instance_type: 'Standard_NV6',
        region: 'eastus',
        provider: 'azure',
        status: 'stopped',
        cost_per_hour: 0.45,
        created_at: '2026-09-20',
      },
    ];

    setMachines(mockMachines);
    setLoading(false);
  }, []);

  const handleStart = (id: string) => {
    setMachines(machines.map(m => m.id === id ? { ...m, status: 'running' } : m));
  };

  const handleStop = (id: string) => {
    setMachines(machines.map(m => m.id === id ? { ...m, status: 'stopped' } : m));
  };

  const handleDelete = (id: string) => {
    setMachines(machines.filter(m => m.id !== id));
  };

  if (loading) {
    return <div className="text-center py-12">Loading machines...</div>;
  }

  return (
    <div>
      <div className="mb-8 flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Machines</h1>
          <p className="text-gray-600">Manage your gaming infrastructure across cloud providers</p>
        </div>
        <button className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-medium">
          Launch Machine
        </button>
      </div>

      {machines.length > 0 ? (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Instance</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Provider</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Region</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Cost/Hour</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">IP Address</th>
                <th className="px-6 py-3 text-right text-sm font-semibold text-gray-900">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {machines.map((machine) => (
                <tr key={machine.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">{machine.instance_type}</td>
                  <td className="px-6 py-4 text-sm text-gray-600">{machine.provider.toUpperCase()}</td>
                  <td className="px-6 py-4 text-sm text-gray-600">{machine.region}</td>
                  <td className="px-6 py-4 text-sm">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                      machine.status === 'running'
                        ? 'bg-green-100 text-green-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}>
                      {machine.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">${machine.cost_per_hour.toFixed(3)}</td>
                  <td className="px-6 py-4 text-sm text-gray-600">{machine.ip_address || '-'}</td>
                  <td className="px-6 py-4 text-sm text-right space-x-2">
                    {machine.status === 'running' ? (
                      <button
                        onClick={() => handleStop(machine.id)}
                        className="text-orange-600 hover:text-orange-700 font-medium"
                      >
                        Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => handleStart(machine.id)}
                        className="text-green-600 hover:text-green-700 font-medium"
                      >
                        Start
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(machine.id)}
                      className="text-red-600 hover:text-red-700 font-medium"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <p className="text-gray-600 mb-4">No machines yet</p>
          <button className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium">
            Launch your first machine
          </button>
        </div>
      )}
    </div>
  );
}
