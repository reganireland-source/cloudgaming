'use client';

import { useState, useEffect } from 'react';
import BillOfMaterials from '@/components/BillOfMaterials';

interface Machine {
  id: string;
  instance_type: string;
  region: string;
  provider: string;
  status: string;
  cost_per_hour: number;
}

interface BoM {
  machine: Machine;
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

export default function Dashboard() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedMachine, setSelectedMachine] = useState<string | null>(null);
  const [boM, setBoM] = useState<BoM | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // In production, fetch from API
    // For now, show mock data
    const mockMachines: Machine[] = [
      {
        id: '1',
        instance_type: 'g4dn.xlarge',
        region: 'us-east-1',
        provider: 'aws',
        status: 'running',
        cost_per_hour: 0.526,
      },
    ];

    const mockBoM: BoM = {
      machine: mockMachines[0],
      billOfMaterials: {
        compute: {
          component: 'g4dn.xlarge',
          quantity: 1,
          unit: 'instance',
          costPerUnit: 0.526,
          total: 0.526,
        },
        streaming: {
          resolution: '1440p',
          fps: 60,
          bitrate: '35 Mbps',
          gbPerHour: 3.6,
          egressRate: 0.12,
          costPerHour: 0.432,
        },
        total: {
          costPerHour: 0.958,
          costPerDay: 22.99,
          costPerMonth: 689.76,
        },
      },
    };

    setMachines(mockMachines);
    setSelectedMachine(mockMachines[0].id);
    setBoM(mockBoM);
    setLoading(false);
  }, []);

  if (loading) {
    return <div className="text-center py-12">Loading...</div>;
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-2">Gaming Infrastructure Dashboard</h1>
        <p className="text-gray-600">Monitor and manage your cloud gaming machines</p>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
        </div>
      )}

      {machines.length > 0 ? (
        <div className="space-y-8">
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Active Machines</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {machines.map((machine) => (
                <button
                  key={machine.id}
                  onClick={() => {
                    setSelectedMachine(machine.id);
                    // In production, fetch the specific machine's BoM
                  }}
                  className={`p-4 rounded-lg border-2 transition ${
                    selectedMachine === machine.id
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-300 hover:border-gray-400'
                  }`}
                >
                  <div className="text-left">
                    <h3 className="font-semibold text-gray-900">{machine.instance_type}</h3>
                    <p className="text-sm text-gray-600">{machine.provider.toUpperCase()} - {machine.region}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className={`text-xs px-2 py-1 rounded ${
                        machine.status === 'running'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}>
                        {machine.status}
                      </span>
                      <span className="text-sm font-bold text-gray-900">${machine.cost_per_hour.toFixed(2)}/hr</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {boM && (
            <BillOfMaterials machine={boM.machine} billOfMaterials={boM.billOfMaterials} />
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-blue-50 rounded-lg p-6 border border-blue-200">
              <p className="text-sm text-gray-600 mb-1">Monthly Projected Cost</p>
              <p className="text-3xl font-bold text-blue-600">
                ${boM ? boM.billOfMaterials.total.costPerMonth.toFixed(2) : '0.00'}
              </p>
              <p className="text-xs text-gray-600 mt-2">For 1 running machine</p>
            </div>
            <div className="bg-green-50 rounded-lg p-6 border border-green-200">
              <p className="text-sm text-gray-600 mb-1">Current Spend (This Month)</p>
              <p className="text-3xl font-bold text-green-600">$0.00</p>
              <p className="text-xs text-gray-600 mt-2">Load real data from API</p>
            </div>
            <div className="bg-purple-50 rounded-lg p-6 border border-purple-200">
              <p className="text-sm text-gray-600 mb-1">Active Machines</p>
              <p className="text-3xl font-bold text-purple-600">{machines.length}</p>
              <p className="text-xs text-gray-600 mt-2">{machines.filter(m => m.status === 'running').length} running</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <p className="text-gray-600 mb-4">No machines running yet</p>
          <a href="/machines" className="text-blue-600 hover:text-blue-800 font-medium">
            Launch your first machine →
          </a>
        </div>
      )}
    </div>
  );
}
