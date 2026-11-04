import { readDocument, writeDocument } from "../db";
import { Network, type DeskSnapshot } from "../world/network";

/**
 * One Node process owns this desk. A second process would still race on the
 * same sqlite file. Mutations go through the queue below.
 */
const globalDesk = globalThis as unknown as {
  muselancerDesk?: Network;
  muselancerDeskQueue?: Promise<void>;
  muselancerDeskDepth?: number;
};

const liveJobs = new Set<string>();

export function markJobRunning(taskId: string): void {
  liveJobs.add(taskId);
}

export function markJobFinished(taskId: string): void {
  liveJobs.delete(taskId);
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  if ((globalDesk.muselancerDeskDepth ?? 0) > 0) return job();
  const previous = globalDesk.muselancerDeskQueue ?? Promise.resolve();
  const run = previous.then(async () => {
    globalDesk.muselancerDeskDepth = (globalDesk.muselancerDeskDepth ?? 0) + 1;
    try {
      return await job();
    } finally {
      globalDesk.muselancerDeskDepth = Math.max(0, (globalDesk.muselancerDeskDepth ?? 1) - 1);
    }
  });
  globalDesk.muselancerDeskQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function loadUnlocked(): Promise<Network> {
  if (globalDesk.muselancerDesk) return globalDesk.muselancerDesk;
  const raw = await readDocument("network");
  if (!raw) {
    globalDesk.muselancerDesk = new Network();
    return globalDesk.muselancerDesk;
  }
  const snapshot = JSON.parse(raw) as DeskSnapshot;
  const net = Network.restore({ ...snapshot, supervisorKey: undefined });
  globalDesk.muselancerDesk = net;
  if (interruptRunningJobs(net)) await persistUnlocked(net);
  return net;
}

function interruptRunningJobs(net: Network): boolean {
  let changed = false;
  for (const task of net.tasks.values()) {
    if (task.status !== "running" || liveJobs.has(task.id)) continue;
    task.jobError = "The sandbox stopped before a delivery.";
    task.status = task.artifactCid ? "revision" : "authorized";
    changed = true;
  }
  return changed;
}

async function persistUnlocked(net: Network): Promise<void> {
  const { supervisorKey, ...stored } = net.snapshot();
  const json = JSON.stringify(stored);
  if (supervisorKey && json.includes(supervisorKey)) throw new Error("Refusing to persist a wallet key.");
  if (json.includes("litShares")) throw new Error("Refusing to persist Lit shares.");
  await writeDocument("network", json);
  globalDesk.muselancerDesk = net;
}

export function desk(): Promise<Network> {
  return enqueue(() => loadUnlocked());
}

export function saveDesk(net: Network): Promise<void> {
  return enqueue(() => persistUnlocked(net));
}

/** Read the current desk, mutate it, and write that snapshot before the next mutation. */
export function withDesk<T>(mutate: (net: Network) => Promise<T> | T): Promise<T> {
  return enqueue(async () => {
    const net = await loadUnlocked();
    const result = await mutate(net);
    await persistUnlocked(net);
    return result;
  });
}
