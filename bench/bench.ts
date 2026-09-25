// Where does loading time go? Loads the robot cell once through the store to learn the
// file list, then measures each phase separately for every COLLADA file, one after the
// other. Open /bench/ on the dev server (npm run dev); results land in <pre id="out"> and
// window.bench. bench/run.mjs drives it from Playwright.
import * as THREE from 'three';
import { ColladaComposer } from 'three/addons/loaders/collada/ColladaComposer.js';
import { parseAml } from '../src/aml/reader';
import { ColladaStore } from '../src/collada/store';
import { WorkerPool } from '../src/collada/pool';
import { buildCell } from '../src/scene/cell';
import { preprocess } from '../src/collada/preprocess';
import { ArrayColladaParser } from '../src/collada/parser';

const out = document.getElementById('out')!;
const amlUrl = new URL(new URLSearchParams(location.search).get('aml') || '../data/robotcell/AmlDocument.aml', location.href).href;
const t = () => performance.now();
const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function run() {
  const aml = parseAml(await (await fetch(amlUrl)).text());
  let t0 = t();
  const pool = new WorkerPool();
  // timeline of the worker tasks, relative to t0
  const tasks: { op: string; start: number; end: number }[] = [];
  const traced = <A extends unknown[], R>(op: string, f: (...a: A) => Promise<R>) => async (...a: A) => {
    const start = t() - t0; const r = await f(...a); tasks.push({ op, start, end: t() - t0 }); return r;
  };
  const pooled = new ColladaStore({ offload: { load: traced('load', pool.load.bind(pool)), buildGeometries: traced('geometry', pool.buildGeometries.bind(pool)) } });
  // explicit references first, so that loading and assembling can be timed apart
  const files = new Set<string>();
  for (const el of aml.byId.values()) for (const c of el.collada) if (c.refType === 'explicit') files.add(new URL(c.file, amlUrl).href);
  await Promise.all([...files].map(f => pooled.load(f)));
  const workersLoad = t() - t0;
  await buildCell(aml, amlUrl, pooled);
  const withWorkers = t() - t0;
  pool.dispose();
  const phase = (op: string) => {
    const list = tasks.filter(x => x.op === op);
    const busy = list.reduce((n, x) => n + x.end - x.start, 0);
    return { tasks: list.length, first: s(Math.min(...list.map(x => x.start))), lastEnd: s(Math.max(...list.map(x => x.end))), meanWait: s(busy / list.length) };
  };
  const timeline = { load: phase('load'), geometry: phase('geometry') };
  t0 = t();
  const store = new ColladaStore();
  await buildCell(aml, amlUrl, store);
  const full = t() - t0;
  const urls = [...store.docs.keys()];
  t0 = t();
  await Promise.all(urls.map(u => fetch(u).then(r => r.arrayBuffer())));
  const parallelFetch = t() - t0;

  const sum = { fetch: 0, preprocess: 0, dom: 0, parse: 0, compose: 0, bytes: 0 };
  for (const url of urls) {
    let a = t(); const text = await (await fetch(url)).text(); sum.fetch += t() - a; sum.bytes += text.length;
    a = t(); const { text: patched, arrays } = preprocess(text); sum.preprocess += t() - a;
    a = t(); new DOMParser().parseFromString(patched, 'application/xml'); sum.dom += t() - a;
    a = t(); const parsed = new ArrayColladaParser(arrays).parse(patched)!; sum.parse += t() - a;
    a = t(); new ColladaComposer(parsed.library, parsed.collada, new THREE.TextureLoader(), null).compose(); sum.compose += t() - a;
  }
  const result = {
    files: urls.length, mb: +(sum.bytes / 1e6).toFixed(0), cores: navigator.hardwareConcurrency,
    full: s(full), withWorkers: s(withWorkers), workersLoad: s(workersLoad), workersMainParse: s(pooled.stats.parseMs), workers: pool.size, parallelFetch: s(parallelFetch), timeline, fetch: s(sum.fetch), preprocess: s(sum.preprocess), dom: s(sum.dom),
    parseWithoutDom: s(sum.parse - sum.dom), compose: s(sum.compose),
  };
  (window as unknown as { bench: unknown }).bench = result;
  out.textContent = JSON.stringify(result, null, 2);
}
run().catch(e => { out.textContent = String(e.stack || e); (window as unknown as { bench: unknown }).bench = { error: String(e) }; });
