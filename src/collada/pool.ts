// Spreads offload work over several Web Workers. A worker gets at most `perWorker` tasks
// at a time (one working, one reading ahead); the rest wait here, geometry tasks first
// because they finish files that are already read. Handing a worker all
// files at once makes it read all of them before working on any, and holding hundreds of
// large texts at once slows it down more than the parallel reading gains.
// Typed arrays are handed over, not copied.
import { transferables, type BuiltGeometry, type LoadedFile, type Offload } from './offload';

interface Task {
  message: Record<string, unknown>;
  transfer: Transferable[];
  resolve(v: unknown): void;
  reject(e: Error): void;
}

interface Slot {
  worker: Worker;
  open: number;
  dead: boolean;
}

export class WorkerPool implements Offload {
  private readonly slots: Slot[];
  private readonly running = new Map<number, Task & { slot: Slot }>();
  private readonly waiting: Task[] = [];
  private next = 0;

  constructor(size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)), private readonly perWorker = 2) {
    this.slots = Array.from({ length: size }, () => {
      const slot: Slot = { worker: new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }), open: 0, dead: false };
      slot.worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
        const task = this.running.get(event.data.id);
        if (!task) return;
        this.running.delete(event.data.id);
        slot.open--;
        this.dispatch();
        if (event.data.error !== undefined) task.reject(new Error(event.data.error));
        else task.resolve(event.data.result);
      };
      // A worker whose script does not load, or that dies, answers nothing more. Its tasks
      // fail; when no worker is left, so does everything that waits.
      slot.worker.onerror = event => {
        event.preventDefault?.();
        this.fail(slot, new Error(`worker failed${event.message ? `: ${event.message}` : ' (its script could not be loaded)'}`));
      };
      slot.worker.onmessageerror = () => this.fail(slot, new Error('worker sent a message that could not be read'));
      return slot;
    });
  }

  get size(): number { return this.slots.length; }

  private fail(slot: Slot, error: Error): void {
    if (slot.dead) return;
    slot.dead = true;
    slot.worker.terminate();
    for (const [id, task] of this.running) if (task.slot === slot) { this.running.delete(id); task.reject(error); }
    if (this.slots.every(s => s.dead)) for (const task of this.waiting.splice(0)) task.reject(error);
    else this.dispatch();
  }

  private dispatch(): void {
    const alive = this.slots.filter(s => !s.dead);
    if (!alive.length) {
      for (const task of this.waiting.splice(0)) task.reject(new Error('no worker left'));
      return;
    }
    while (this.waiting.length) {
      const slot = alive.reduce((a, b) => (b.open < a.open ? b : a));
      if (slot.open >= this.perWorker) return;
      const task = this.waiting.shift()!;
      const id = this.next++;
      slot.open++;
      this.running.set(id, { ...task, slot });
      slot.worker.postMessage({ ...task.message, id }, task.transfer);
    }
  }

  private run<T>(message: Record<string, unknown>, transfer: Transferable[] = [], first = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = { message, transfer, resolve: resolve as (v: unknown) => void, reject };
      if (first) this.waiting.unshift(task); else this.waiting.push(task);
      this.dispatch();
    });
  }

  load(url: string): Promise<LoadedFile> {
    return this.run({ op: 'load', url });
  }

  buildGeometries(geometries: Record<string, unknown>): Promise<Record<string, BuiltGeometry>> {
    return this.run({ op: 'geometries', geometries }, transferables(geometries), true);
  }

  dispose(): void {
    for (const s of this.slots) { s.dead = true; s.worker.terminate(); }
    for (const task of [...this.running.values(), ...this.waiting]) task.reject(new Error('worker pool disposed'));
    this.running.clear();
    this.waiting.length = 0;
  }
}
