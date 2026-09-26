// The pool with stand-in workers: what happens when a worker cannot start or dies.
import { WorkerPool } from '../src/collada/pool';

type Behaviour = 'fail at start' | 'answer' | 'die on work';

/** Stand-in workers; each one created takes the next behaviour from the list. */
function fakeWorkers(behaviours: Behaviour[]) {
  const created: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    readonly behaviour: Behaviour = behaviours[created.length] ?? 'answer';
    constructor() {
      created.push(this);
      if (this.behaviour === 'fail at start') setTimeout(() => this.onerror?.({ message: '', preventDefault() {} }));
    }
    postMessage(message: { id: number; url?: string }) {
      if (this.behaviour === 'die on work') setTimeout(() => this.onerror?.({ message: 'out of memory', preventDefault() {} }));
      else if (this.behaviour === 'answer') setTimeout(() => this.onmessage?.({ data: { id: message.id, result: message.url } }));
    }
    terminate() { this.terminated = true; }
  }
  vi.stubGlobal('Worker', FakeWorker);
  return created;
}

afterEach(() => vi.unstubAllGlobals());

describe('WorkerPool', () => {
  it('fails every task when no worker can start, instead of waiting for ever', async () => {
    fakeWorkers(['fail at start', 'fail at start']);
    const pool = new WorkerPool(2);
    await expect(Promise.all([pool.load('a'), pool.load('b'), pool.load('c')])).rejects.toThrow(/worker failed/);
  });

  it('fails the tasks of a worker that dies and goes on with the others', async () => {
    const workers = fakeWorkers(['die on work', 'answer']);
    const pool = new WorkerPool(2, 1);
    const results = await Promise.allSettled([pool.load('a'), pool.load('b'), pool.load('c'), pool.load('d')]);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<unknown>).value)).toHaveLength(3);
    expect(workers[0].terminated).toBe(true);
  });

  it('fails what is left when it is disposed', async () => {
    fakeWorkers(['answer']);
    const pool = new WorkerPool(1, 1);
    const first = pool.load('a'), second = pool.load('b');
    pool.dispose();
    await expect(first).rejects.toThrow(/disposed/);
    await expect(second).rejects.toThrow(/disposed/);
  });
});
