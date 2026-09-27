'use client';

import { useState, useEffect } from 'react';
import StreamingClientModal from '@/components/StreamingClientModal';

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
  const [streamingModalOpen, setStreamingModalOpen] = useState(false);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);

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
    if (selectedMachineId === id) {
      setStreamingModalOpen(false);
      setSelectedMachineId(null);
    }
  };

  const handleConnect = (machineId: string, machineIp?: string) => {
    if (!machineIp) {
      console.error('Machine IP address not available');
      return;
    }
    setSelectedMachineId(machineId);
    setStreamingModalOpen(true);
  };

  const handleCloseModal = () => {
    setStreamingModalOpen(false);
    setSelectedMachineId(null);
  };

  if (loading) {
    return (
      <div className="text-center py-12">
        <p className="font-mono text-neon-cyan text-lg">
          {'> SCANNING_INSTANCES...'}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-xl font-bold neon-text mb-2 font-mono">
            [ INSTANCE_MANAGER ]
          </h1>
          <p className="font-mono text-sm text-neon-lime">
            {'> manage_gaming_infrastructure_across_providers'.toUpperCase()}
          </p>
        </div>
        <button className="btn-neon-magenta font-mono whitespace-nowrap">
          [ LAUNCH_VM ]
        </button>
      </div>

      {machines.length > 0 ? (
        <div className="neon-card rounded-lg border border-neon-cyan/30 overflow-x-auto">
          <table className="min-w-full font-mono text-sm">
            <thead className="border-b border-neon-cyan/30">
              <tr className="bg-cyan-950/20">
                <th className="px-6 py-4 text-left text-neon-cyan font-bold">[INSTANCE]</th>
                <th className="px-6 py-4 text-left text-neon-magenta font-bold">[PROVIDER]</th>
                <th className="px-6 py-4 text-left text-neon-lime font-bold">[REGION]</th>
                <th className="px-6 py-4 text-left text-neon-pink font-bold">[STATUS]</th>
                <th className="px-6 py-4 text-left text-neon-cyan font-bold">[COST/HR]</th>
                <th className="px-6 py-4 text-left text-neon-lime font-bold">[IP]</th>
                <th className="px-6 py-4 text-right text-neon-magenta font-bold">[ACTIONS]</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neon-cyan/20">
              {machines.map((machine) => (
                <tr key={machine.id} className="hover:bg-cyan-950/10 transition-colors">
                  <td className="px-6 py-4 text-neon-cyan font-bold">{machine.instance_type}</td>
                  <td className="px-6 py-4 text-neon-magenta">{machine.provider.toUpperCase()}</td>
                  <td className="px-6 py-4 text-neon-lime">{machine.region}</td>
                  <td className="px-6 py-4">
                    <span className={`px-3 py-1 rounded text-xs font-bold border ${
                      machine.status === 'running'
                        ? 'border-neon-lime text-neon-lime bg-green-950/20'
                        : 'border-neon-cyan/50 text-neon-cyan/70 bg-cyan-950/10'
                    }`}>
                      [{machine.status.toUpperCase()}]
                    </span>
                  </td>
                  <td className="px-6 py-4 text-neon-pink font-bold">${machine.cost_per_hour.toFixed(3)}</td>
                  <td className="px-6 py-4 text-neon-lime text-xs">{machine.ip_address || '—'}</td>
                  <td className="px-6 py-4 text-right space-x-2 flex justify-end">
                    {machine.status === 'running' ? (
                      <>
                        <button
                          onClick={() => handleConnect(machine.id, machine.ip_address)}
                          className="bg-neon-cyan text-slate-900 hover:bg-cyan-300 rounded px-3 py-1 text-xs font-bold transition-all"
                          title="Connect to this machine for streaming"
                        >
                          CONNECT
                        </button>
                        <button
                          onClick={() => handleStop(machine.id)}
                          className="btn-neon-pink text-xs py-1 px-3"
                        >
                          STOP
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => handleStart(machine.id)}
                        className="btn-neon-lime text-xs py-1 px-3"
                      >
                        RUN
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(machine.id)}
                      className="border border-red-600/50 text-red-500 hover:text-red-400 hover:border-red-500 rounded px-3 py-1 text-xs font-bold transition-all"
                    >
                      DEL
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="neon-card rounded-lg p-12 text-center border border-neon-cyan/30">
          <p className="font-mono text-neon-lime mb-6">
            {'> NO_INSTANCES_DETECTED'}
          </p>
          <button className="btn-neon-magenta">
            [ DEPLOY_FIRST_MACHINE ]
          </button>
        </div>
      )}

      {selectedMachineId && (
        <StreamingClientModal
          machineId={selectedMachineId}
          machineIp={machines.find(m => m.id === selectedMachineId)?.ip_address || ''}
          isOpen={streamingModalOpen}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
}
