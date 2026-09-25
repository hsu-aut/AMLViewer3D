// Loads COLLADA documents with three.js' parser and composer, after the rewrites in
// preprocess.ts, and fills the <instance_node> placeholders with copies of the referenced
// nodes, from the same or another file. Coordinates stay as in the file (Z up); `unit`
// says how many metres one file unit is.

import * as THREE from 'three';
import { ColladaComposer } from 'three/addons/loaders/collada/ColladaComposer.js';
import { preprocess, NODE_TAG, PLACEHOLDER } from './preprocess';
import { ArrayColladaParser } from './parser';
import { hasKinematics, readKinematics, type Kinematics } from './kinematics';

export interface ColladaDoc {
  url: string;
  name: string;
  unit: number;
  root: THREE.Group;
  kinematics: Kinematics | null;
  /** A node of this file with all its instances filled, built on first use. */
  node(id: string): Promise<THREE.Object3D | null>;
}

export interface StoreStats {
  files: number;
  bytes: number;
  parseMs: number;
  missing: string[];
}

const baseName = (url: string) => decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() ?? url);
const dirOf = (url: string) => url.slice(0, url.lastIndexOf('/') + 1);

/** Key of a COLLADA node that survives copying: "<file name>#<node id>". */
export const nodeKey = (fileUrl: string, nodeId: string) => `${baseName(fileUrl)}#${nodeId}`;

export class ColladaStore {
  readonly docs = new Map<string, Promise<ColladaDoc>>();
  readonly stats: StoreStats = { files: 0, bytes: 0, parseMs: 0, missing: [] };
  private readonly fetchText: (url: string) => Promise<string>;

  constructor(options: { fetchText?: (url: string) => Promise<string> } = {}) {
    this.fetchText = options.fetchText ?? (async url => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.text();
    });
  }

  load(url: string, chain: string[] = []): Promise<ColladaDoc> {
    const abs = new URL(url, globalThis.location?.href ?? 'file:///').href;
    if (chain.includes(abs)) return Promise.reject(new Error(`reference cycle: ${[...chain, abs].map(baseName).join(' -> ')}`));
    let doc = this.docs.get(abs);
    if (!doc) { doc = this.read(abs, [...chain, abs]); this.docs.set(abs, doc); }
    return doc;
  }

  private async read(url: string, chain: string[]): Promise<ColladaDoc> {
    const text = await this.fetchText(url);
    const t0 = performance.now();
    const { text: patched, reduced, arrays, refs } = preprocess(text);
    const parsed = text.trim() ? new ArrayColladaParser(arrays).parse(patched) : null;
    if (!parsed) throw new Error('not a readable COLLADA document');
    const { library, asset, collada } = parsed;
    const composer = new ColladaComposer(library, collada, new THREE.TextureLoader().setPath(dirOf(url)), null);
    const root = composer.compose().scene;
    this.stats.parseMs += performance.now() - t0;
    this.stats.files++;
    this.stats.bytes += text.length;

    // Tag node objects; draw both sides because CAD exports often mix the winding order.
    const tag = (object: THREE.Object3D) => object.traverse(o => {
      if (!o.userData.nodeKey && o.name?.startsWith(NODE_TAG)) o.userData.nodeKey = nodeKey(url, o.name.slice(NODE_TAG.length));
      if ((o as THREE.Mesh).isMesh) for (const m of [(o as THREE.Mesh).material].flat()) m.side = THREE.DoubleSide;
    });

    // Fill placeholders in place. A node is filled before it is copied, so copies are complete.
    const fill = async (object: THREE.Object3D) => {
      const holders: [THREE.Object3D, (typeof refs)[number]][] = [];
      object.traverse(o => {
        const m = PLACEHOLDER.exec(o.name ?? '');
        if (m && !o.userData.filled) { o.userData.filled = true; holders.push([o, refs[+m[1]]]); }
      });
      await Promise.all(holders.map(async ([holder, ref]) => {
        const where = `${ref.file}#${ref.id}`;
        let source: THREE.Object3D | null = null;
        let sourceDoc: ColladaDoc = doc;
        try {
          if (ref.file) sourceDoc = await this.load(new URL(ref.file, url).href, chain);
          source = await sourceDoc.node(ref.id);
        } catch (e) {
          this.stats.missing.push(`${baseName(url)}: ${where} (${(e as Error).message})`);
          return;
        }
        if (!source) { this.stats.missing.push(`${baseName(url)}: ${where} not found`); return; }
        const copy = source.clone(true);
        holder.name = `instance ${where}`;
        if (sourceDoc.unit !== doc.unit) {
          const wrapper = new THREE.Group();
          wrapper.scale.setScalar(sourceDoc.unit / doc.unit);
          wrapper.add(copy);
          holder.add(wrapper);
        } else holder.add(copy);
      }));
    };

    const built = new Map<string, Promise<THREE.Object3D | null>>();
    const doc: ColladaDoc = {
      url,
      name: baseName(url),
      unit: asset.unit || 1,
      root,
      kinematics: hasKinematics(reduced) ? readKinematics(reduced) : null,
      node: id => {
        let b = built.get(id);
        if (!b) {
          b = (async () => {
            if (!library.nodes[id]) return null;
            const object = composer.getNode(id);
            tag(object);
            await fill(object);
            return object;
          })();
          built.set(id, b);
        }
        return b;
      },
    };
    tag(root);
    await fill(root);
    return doc;
  }
}
