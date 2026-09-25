// Throughput of the worker pool alone: every COLLADA file of the robot cell at once.
import { WorkerPool } from '../src/collada/pool';
import { loadFile } from '../src/collada/offload';

const out = document.getElementById('out')!;
const dir = new URL('../data/robotcell/', location.href).href;
const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function run() {
  const aml = await (await fetch(dir + 'AmlDocument.aml')).text();
  // file list: every .dae named in the AML or in a COLLADA file, found by fetching them all once
  const seen = new Set<string>();
  const queue = [...aml.matchAll(/dae_lib\/([^"#<]+\.dae)/g)].map(m => dir + 'dae_lib/' + m[1]);
  while (queue.length) {
    const u = queue.pop()!;
    if (seen.has(u)) continue;
    seen.add(u);
    const text = await (await fetch(u)).text();
    for (const m of text.matchAll(/url="([^"#]+\.dae)#/g)) queue.push(new URL(m[1], u).href);
  }
  const urls = [...seen];
  const result: Record<string, unknown> = { files: urls.length };
  for (const size of [1, 8, 15]) {
    const pool = new WorkerPool(size);
    await pool.load(urls[0]);                 // start-up
    const t0 = performance.now();
    await Promise.all(urls.map(u => pool.load(u)));
    result[`pool${size}`] = s(performance.now() - t0);
    pool.dispose();
  }
  let t0 = performance.now();
  for (const u of urls) await loadFile(u);
  result.mainThreadSequential = s(performance.now() - t0);
  t0 = performance.now();
  await Promise.all(urls.map(u => fetch(u).then(r => r.text())));
  result.fetchOnly = s(performance.now() - t0);
  (window as unknown as { bench: unknown }).bench = result;
  out.textContent = JSON.stringify(result, null, 2);
}
run().catch(e => { out.textContent = String(e.stack || e); (window as unknown as { bench: unknown }).bench = { error: String(e) }; });
