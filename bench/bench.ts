// Where does loading time go? Loads the robot cell once through the store to learn the
// file list, then measures each phase separately for every COLLADA file, one after the
// other. Open /bench/ on the dev server (npm run dev); results land in <pre id="out"> and
// window.bench. bench/run.mjs drives it from Playwright.
import * as THREE from 'three';
import { ColladaComposer } from 'three/addons/loaders/collada/ColladaComposer.js';
import { parseAml } from '../src/aml/reader';
import { ColladaStore } from '../src/collada/store';
import { buildCell } from '../src/scene/cell';
import { preprocess } from '../src/collada/preprocess';
import { ArrayColladaParser } from '../src/collada/parser';

const out = document.getElementById('out')!;
const amlUrl = new URL(new URLSearchParams(location.search).get('aml') || '../data/robotcell/AmlDocument.aml', location.href).href;
const t = () => performance.now();
const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function run() {
  const t0 = t();
  const store = new ColladaStore();
  await buildCell(parseAml(await (await fetch(amlUrl)).text()), amlUrl, store);
  const full = t() - t0;
  const urls = [...store.docs.keys()];

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
    full: s(full), fetch: s(sum.fetch), preprocess: s(sum.preprocess), dom: s(sum.dom),
    parseWithoutDom: s(sum.parse - sum.dom), compose: s(sum.compose),
  };
  (window as unknown as { bench: unknown }).bench = result;
  out.textContent = JSON.stringify(result, null, 2);
}
run().catch(e => { out.textContent = String(e.stack || e); (window as unknown as { bench: unknown }).bench = { error: String(e) }; });
