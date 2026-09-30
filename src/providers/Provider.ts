/**
 * ============================================================================
 * src/providers/Provider.ts — THE CONTRACT EVERY CLOUD MUST FOLLOW
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * AWS, Azure, Google Cloud (GCP) and Oracle all do the same basic things —
 * start a server, stop it, back up its disk — but each has a completely
 * different API for doing them. We don't want the rest of the app full of
 * "if AWS do this, else if Azure do that...".
 *
 * So we define ONE common list of operations here: the CloudProvider class.
 * Each cloud gets its own file (AWSProvider.ts, AzureProvider.ts, ...) that
 * fills in HOW to do each operation for that cloud. The rest of the app
 * only ever talks to "a CloudProvider" and doesn't care which one it is.
 * This is a classic design pattern: an ABSTRACTION or INTERFACE.
 *
 * KEY TERMS
 * ---------
 * - `abstract class`: a class you can't create directly — it's a template.
 *   Other classes `extend` it.
 * - `abstract` method: a method with only a signature (name, inputs, output)
 *   and no body. Every class that extends CloudProvider MUST provide it, or
 *   TypeScript refuses to compile. That guarantees every provider supports
 *   every operation (even if, for now, the body just says "Not implemented").
 * - `Promise<X>`: the method is asynchronous (it talks to the network) and
 *   will eventually produce an X. Callers `await` it.
 *
 * CURRENT STATE: only AWSProvider is really implemented. Azure, GCP and
 * Oracle are placeholders whose methods throw "Not implemented".
 * ============================================================================
 */

import { Machine, RegionData, Snapshot } from '../types';
import type { Reporter, EventLevel } from '../services/OperationLog';
import type { SetupStage, InventoryItem } from './shared/types';

/** Where and what to launch. */
export interface ProviderConfig {
  region: string;          // e.g. 'ap-southeast-1'
  instanceType: string;    // the machine size, e.g. 'g4dn.xlarge'
}

/** Extra launch settings. */
/**
 * Restoring a SHELVED machine: keep its original Sunshine login (so the app's
 * stored login and Moonlight's pairing still match), auto-stop and disk size.
 * Omitted = the old behaviour (fresh random login, 150 GB, on-demand).
 */
export interface RestoreOptions {
  sunshineUsername?: string;
  sunshinePassword?: string;
  autoStopMinutes?: number;
  diskSizeGb?: number;
  spot?: boolean;
  /** EXPERIMENTAL big screen: NVIDIA's GRID driver (4096x2160) instead of the datacenter one (2560x1600). */
  displayDriver?: 'standard' | 'grid';
}

export interface LaunchOptions {
  imageId: string;         // the disk template to boot from (for AWS, an AMI id)
  keyName: string;         // name of the SSH key pair allowed to log in
  securityGroupId: string; // firewall rules: which ports are open to the internet
  spotInstance?: boolean;  // true = use cheap "spare capacity" pricing (can be interrupted)
  // Used by providers that set the machine up themselves (GCP); others ignore them.
  diskSizeGb?: number;     // size of the machine's disk
  sunshineUsername?: string; // login for the streaming server's admin page
  sunshinePassword?: string;
  /** Minutes without streaming before the machine shuts itself down (0 = never). */
  autoStopMinutes?: number;
  /** EXPERIMENTAL big screen: NVIDIA's GRID driver (4096x2160) instead of the datacenter one (2560x1600). */
  displayDriver?: 'standard' | 'grid';
}

/** Basic facts about an existing snapshot. */
export interface SnapshotInfo {
  id: string;
  sizeGb: number;
  state: string;           // e.g. 'pending' while being created, 'completed' when ready
  /** GB actually stored (what the cloud bills), where the cloud reports it. Usually far less than sizeGb. */
  storedGb?: number;
}

export abstract class CloudProvider {
  /** Which cloud this is. Each subclass sets it, e.g. name = 'aws'. */
  abstract name: 'aws' | 'azure' | 'gcp' | 'oracle';

  /**
   * true = the provider installs the streaming software itself (e.g. GCP
   * via a startup script), so MachineService must NOT run the SSH-based
   * CloudyPad setup after launching.
   */
  readonly selfConfiguring: boolean = false;

  // ---- Progress commentary ---------------------------------------------
  // A provider can narrate what it's doing ("Trying zone -b…") into the
  // operation log the frontend shows live. Callers hand in a reporter with
  // setReporter(op.reporter); without one, report() is a silent no-op.
  protected reporter?: Reporter;

  setReporter(reporter: Reporter | undefined): this {
    this.reporter = reporter;
    return this; // returning `this` allows getProvider(...).setReporter(r).launchInstance(...)
  }

  protected async report(level: EventLevel, message: string, detail?: string): Promise<void> {
    if (this.reporter) await this.reporter(level, message, detail);
  }

  /**
   * Progress of the on-machine setup script (shared/setupScript.ts), read
   * from the machine's serial console via the cloud's API. Providers that
   * can read it override this; the default says "unknown" ([]).
   */
  async getSetupProgress(_instanceId: string): Promise<SetupStage[]> {
    return [];
  }

  /**
   * Restart a running machine (the on-machine setup is a boot service that
   * skips finished steps, so this resumes a setup that went quiet). Default:
   * stop, then start; clouds with a real reboot override it (keeps the IP).
   */
  async rebootInstance(instanceId: string): Promise<void> {
    await this.stopInstance(instanceId);
    await this.startInstance(instanceId);
  }

  /**
   * Why a machine stopped when nobody pressed Stop, if the cloud says:
   * e.g. a spot machine reclaimed, or it shut itself down. null = unknown.
   */
  async getStopReason(_instanceId: string): Promise<string | null> {
    return null;
  }

  /**
   * Can a STOPPED machine switch between spot and on-demand in place (same
   * disk, same machine)? Google: yes. AWS, Azure and Oracle can't convert an
   * existing machine; there the switch applies when it's rebuilt from its
   * snapshot (Shelve, then Restore).
   */
  readonly canSwitchSpotInPlace: boolean = false;

  /** Switch a stopped machine between spot (true) and on-demand (false). */
  async setSpot(_instanceId: string, _spot: boolean): Promise<void> {
    throw new Error('This cloud can’t switch an existing machine between spot and on-demand. Shelve it, change the pricing, then Restore.');
  }

  /**
   * Everything the app has created in the user's account on this cloud —
   * machines AND supporting resources (disks, networks, firewalls, public
   * IPs, snapshots...) — for the infrastructure map. Found by our tag/label
   * (app=cloudgaming-hub) or our naming conventions. Flags "orphans":
   * things that still cost money but aren't attached to any machine.
   * Should not throw for "nothing found"; may throw for credential/API errors.
   * Default: nothing (providers override it).
   */
  async listResources(): Promise<InventoryItem[]> {
    return [];
  }

  /**
   * Create and boot a brand-new virtual machine.
   * Returns the provider's id for it, its IP address, and its hourly price.
   */
  abstract launchInstance(
    config: ProviderConfig,
    options: LaunchOptions
  ): Promise<{ instanceId: string; ipAddress: string; costPerHour: number }>;

  /**
   * Power a machine OFF, keeping its disk. Compute billing stops; you still
   * pay a little for the disk.
   */
  abstract stopInstance(instanceId: string): Promise<void>;

  /**
   * Power a stopped machine back ON.
   */
  abstract startInstance(instanceId: string): Promise<void>;

  /**
   * DESTROY a machine and its disk permanently ("terminate" is the cloud
   * term). All billing for it stops.
   */
  abstract terminateInstance(instanceId: string): Promise<void>;

  /**
   * Ask the cloud what state a machine is in right now, and its IP address.
   */
  abstract getInstanceStatus(instanceId: string): Promise<{
    // 'starting' / 'stopping' = in between; the cloud is still working on it.
    status: 'starting' | 'running' | 'stopping' | 'stopped' | 'terminated' | 'unknown';
    ipAddress?: string;
  }>;

  /**
   * Take a snapshot (point-in-time backup) of a machine's disk.
   */
  abstract createSnapshot(
    instanceId: string,
    diskPath: string
  ): Promise<{ snapshotId: string; sizeGb: number }>;

  /**
   * Look up an existing snapshot.
   */
  abstract getSnapshot(snapshotId: string): Promise<SnapshotInfo>;

  /**
   * Permanently delete a snapshot (stops its storage charges).
   */
  abstract deleteSnapshot(snapshotId: string): Promise<void>;

  /**
   * Create a new machine whose disk starts as a copy of a snapshot — i.e.
   * bring back a machine with all your games already installed.
   */
  abstract restoreFromSnapshot(
    snapshotId: string,
    config: ProviderConfig,
    options?: RestoreOptions
  ): Promise<{ instanceId: string; ipAddress: string }>;

  /**
   * Copy a snapshot from another provider/region into this provider, for
   * cross-cloud portability. Providers that can't yet import a foreign
   * snapshot format should throw with a clear "not implemented" message.
   */
  abstract replicateSnapshot(
    sourceSnapshotId: string,
    sourceProvider: string,
    sourceRegion: string,
    targetRegion: string
  ): Promise<{ snapshotId: string }>;

  /**
   * List the regions this cloud offers, with location and pricing.
   */
  abstract getRegions(): Promise<RegionData[]>;

  /**
   * Hourly price of a machine type in a region. `spot` asks for the cheaper,
   * interruptible spot price as well.
   */
  abstract getInstanceCost(
    region: string,
    instanceType: string,
    spot?: boolean
  ): Promise<{ onDemandPrice: number; spotPrice?: number }>;

  /**
   * Price per gigabyte of data sent out of this region to the internet
   * ("egress"). For game streaming this is a big part of the bill, because
   * the video stream is all outgoing data.
   */
  abstract getEgressCostPerGb(region: string): Promise<number>;

  /**
   * Ask the cloud's billing system what was actually spent between two dates.
   */
  abstract queryCosts(userId: string, startDate: Date, endDate: Date): Promise<{
    computeCost: number;
    egressCost: number;
    storageCost: number;
  }>;

  /**
   * Check that the stored credentials actually work (true) or not (false).
   */
  abstract validateCredentials(): Promise<boolean>;
}
