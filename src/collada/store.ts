// Loads COLLADA documents with three.js' parser and composer, after the rewrites in
// preprocess.ts, and fills the <instance_node> placeholders with copies of the referenced
// nodes, from the same or another file. Coordinates stay as in the file (Z up); `unit`
// says how many metres one file unit is.
//
// With an Offload (a WorkerPool in the browser), reading, preprocessing and building the
// geometries run in workers; only the small XML skeleton is parsed in this thread.

import * as THREE from 'three';
import { NODE_TAG, PLACEHOLDER } from './preprocess';
import { loadFile, toThree, type Offload } from './offload';
import { ArrayColladaParser, PrebuiltColladaComposer } from './parser';
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
  /** Time spent in this thread parsing the XML skeleton and composing the scene. */
  parseMs: number;
  /** Time spent reading number lists and rewriting, in workers or here. */
  preprocessMs: number;
  missing: string[];
}

const baseName = (url: string) => decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() ?? url);
const dirOf = (url: string) => url.slice(0, url.lastIndexOf('/') + 1);

/** Key of a COLLADA node that survives copying: "<file name>#<node id>". */
export const nodeKey = (fileUrl: string, nodeId: string) => `${baseName(fileUrl)}#${nodeId}`;

export class ColladaStore {
  readonly docs = new Map<string, Promise<ColladaDoc>>();
  readonly stats: StoreStats = { files: 0, bytes: 0, parseMs: 0, preprocessMs: 0, missing: [] };
  private readonly fetchText: ((url: string) => Promise<string>) | undefined;
  private readonly offload: Offload | undefined;

  constructor(options: { fetchText?: (url: string) => Promise<string>; offload?: Offload } = {}) {
    this.fetchText = options.fetchText;
    this.offload = options.offload;
  }

  load(url: string, chain: string[] = []): Promise<ColladaDoc> {
    const abs = new URL(url, globalThis.location?.href ?? 'file:///').href;
    if (chain.includes(abs)) return Promise.reject(new Error(`reference cycle: ${[...chain, abs].map(baseName).join(' -> ')}`));
    let doc = this.docs.get(abs);
    if (!doc) { doc = this.read(abs, [...chain, abs]); this.docs.set(abs, doc); }
    return doc;
  }

  private async read(url: string, chain: string[]): Promise<ColladaDoc> {
    const { text: patched, reduced, arrays, refs, bytes, ms } = this.offload ? await this.offload.load(url) : await loadFile(url, this.fetchText);
    // Ask for the referenced files now, so that they load while this one is being built.
    for (const ref of refs) if (ref.file) this.load(new URL(ref.file, url).href, chain).catch(() => {});
    let t0 = performance.now();
    const parsed = patched.trim() ? new ArrayColladaParser(arrays).parse(patched) : null;
    if (!parsed) throw new Error('not a readable COLLADA document');
    const { library, asset, collada } = parsed;
    const parseMs = performance.now() - t0;
    if (this.offload) {
      const geometries = library.geometries as Record<string, { build?: unknown }>;
      const built = await this.offload.buildGeometries(geometries);
      for (const [id, b] of Object.entries(built)) geometries[id].build = toThree(b);
    }
    t0 = performance.now();
    const composer = new PrebuiltColladaComposer(library, collada, new THREE.TextureLoader().setPath(dirOf(url)), null);
    const root = composer.compose().scene;
    this.stats.parseMs += parseMs + performance.now() - t0;
    this.stats.preprocessMs += ms;
    this.stats.files++;
    this.stats.bytes += bytes;

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
