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
    return (
      <div className="text-center py-12">
        <div className="inline-block">
          <p className="font-mono text-neon-cyan text-lg mb-4">
            > INITIALIZING NEON_CORE...
          </p>
          <div className="flex gap-2 justify-center">
            <div className="w-2 h-2 bg-neon-cyan rounded-full animate-pulse"></div>
            <div className="w-2 h-2 bg-neon-magenta rounded-full animate-pulse" style={{animationDelay: '0.1s'}}></div>
            <div className="w-2 h-2 bg-neon-lime rounded-full animate-pulse" style={{animationDelay: '0.2s'}}></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-4xl font-bold neon-text mb-2">
          ▲ GAMING_INFRASTRUCTURE_DASH
        </h1>
        <p className="font-mono text-sm text-neon-lime">
          {'> monitor_and_manage_cloud_resources'.toUpperCase()}
        </p>
      </div>

      {error && (
        <div className="mb-4 p-4 border-l-4 border-neon-pink bg-red-950/30 rounded text-neon-pink font-mono text-sm">
          <span className="font-bold">⚠ ERROR:</span> {error}
        </div>
      )}

      {machines.length > 0 ? (
        <div className="space-y-8">
          <div className="neon-card rounded-lg p-6">
            <h2 className="text-2xl font-bold neon-text mb-6 font-mono">
              [ ACTIVE_INSTANCES ]
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {machines.map((machine) => (
                <button
                  key={machine.id}
                  onClick={() => {
                    setSelectedMachine(machine.id);
                  }}
                  className={`p-4 rounded-lg border-2 transition font-mono text-sm ${
                    selectedMachine === machine.id
                      ? 'neon-card-magenta border-neon-magenta'
                      : 'neon-card border-neon-cyan hover:border-neon-magenta'
                  }`}
                >
                  <div className="text-left">
                    <h3 className="font-bold text-neon-cyan">{machine.instance_type}</h3>
                    <p className="text-neon-lime text-xs mt-1">{machine.provider.toUpperCase()} / {machine.region}</p>
                    <div className="mt-3 flex items-center justify-between">
                      <span className={`text-xs px-2 py-1 rounded font-mono ${
                        machine.status === 'running'
                          ? 'border border-neon-lime text-neon-lime bg-green-950/20'
                          : 'border border-neon-cyan/50 text-neon-cyan/50'
                      }`}>
                        [{machine.status.toUpperCase()}]
                      </span>
                      <span className="text-neon-magenta font-bold text-sm">${machine.cost_per_hour.toFixed(2)}/hr</span>
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
            <div className="neon-card-cyan rounded-lg p-6 border border-neon-cyan font-mono">
              <p className="text-xs text-neon-lime mb-2 font-bold">COST_PROJECTION_MONTHLY</p>
              <p className="text-4xl font-bold text-neon-cyan">
                ${boM ? boM.billOfMaterials.total.costPerMonth.toFixed(2) : '0.00'}
              </p>
              <p className="text-xs text-neon-cyan/60 mt-2">1 active_machine</p>
            </div>
            <div className="neon-card-lime rounded-lg p-6 border border-neon-lime font-mono">
              <p className="text-xs text-neon-cyan mb-2 font-bold">CURRENT_SPEND_MONTH</p>
              <p className="text-4xl font-bold text-neon-lime">$0.00</p>
              <p className="text-xs text-neon-lime/60 mt-2">awaiting_api_integration</p>
            </div>
            <div className="neon-card-magenta rounded-lg p-6 border border-neon-magenta font-mono">
              <p className="text-xs text-neon-cyan mb-2 font-bold">ACTIVE_INSTANCES</p>
              <p className="text-4xl font-bold text-neon-magenta">{machines.length}</p>
              <p className="text-xs text-neon-magenta/60 mt-2">{machines.filter(m => m.status === 'running').length} running</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="neon-card rounded-lg p-12 text-center border border-neon-cyan">
          <p className="font-mono text-neon-lime mb-6">
            > NO_MACHINES_DETECTED
          </p>
          <a href="/machines" className="inline-block btn-neon-lime">
            [ LAUNCH_FIRST_INSTANCE ]
          </a>
        </div>
      )}
    </div>
  );
}
