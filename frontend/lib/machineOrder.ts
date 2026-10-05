/**
 * lib/machineOrder.ts — ONE ORDER FOR MACHINE LISTS (Machines, Performance)
 *
 * Running first, then machines mid-change (starting, stopping…), then
 * stopped, then shelved; newest first within each. Failed / missing ones
 * (launches that never produced a machine) are "dead": the Machines page
 * lists them separately, Performance hides them.
 */

export const STATUS_RANK: Record<string, number> = {
  running: 0, creating: 1, starting: 1, stopping: 1, deleting: 1, shelving: 1, restoring: 1, stopped: 2, shelved: 3,
};

export const isDeadStatus = (status: string) => ['failed', 'missing', 'terminated', 'deleted'].includes(status);

export function byMachineOrder(a: { status: string; created_at: string }, b: { status: string; created_at: string }) {
  return (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3)
    || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}
