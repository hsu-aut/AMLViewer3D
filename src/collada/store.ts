// Loads COLLADA documents with three.js' parser and composer, after the rewrites in
// preprocess.ts, and fills the <instance_node> placeholders with copies of the referenced
// nodes, from the same or another file. Coordinates stay as in the file (Z up); `unit`
// says how many metres one file unit is.
//
// With an Offload (a WorkerPool in the browser), reading, preprocessing and building the
// geometries run in workers; only the small XML skeleton is parsed in this thread.
//
// Files may refer to each other both ways (a.dae uses a node of b.dae and b.dae one of
// a.dae). So a placeholder waits for the one node it copies, not for the other file as a
// whole, and only a chain of nodes that contain themselves is a cycle.

import * as THREE from 'three';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { NODE_TAG, PLACEHOLDER, type NodeRef } from './preprocess';
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

/** Decodes %-escapes where they are valid ("100%.dae" stays as it is). */
export const decodeName = (text: string) => {
  try { return decodeURIComponent(text); } catch { return text; }
};

const baseName = (url: string) => decodeName(url.split(/[?#]/)[0].split(/[\\/]/).pop() ?? url);
const dirOf = (url: string) => url.slice(0, url.lastIndexOf('/') + 1);

/**
 * Key of a COLLADA node that survives copying: "<file name>#<node id>". The file name is
 * compared without case: Windows, where AML files come from, does not tell "Robot.dae"
 * from "robot.dae", and references in one document spell names both ways.
 */
export const nodeKey = (fileUrl: string, nodeId: string) => `${baseName(fileUrl).toLowerCase()}#${nodeId}`;

/** One URL per file however it is spelled (case, escapes). */
const fileKey = (url: string) => decodeName(url.split('#')[0]).toLowerCase();

export class ColladaStore {
  /** Files composed (their nodes can be copied), by file key. */
  private readonly composed = new Map<string, Promise<ColladaDoc & { fillRoot(): Promise<void> }>>();
  /** Files complete (the whole scene filled), by file key. */
  readonly docs = new Map<string, Promise<ColladaDoc>>();
  readonly stats: StoreStats = { files: 0, bytes: 0, parseMs: 0, preprocessMs: 0, missing: [] };
  private readonly fetchText: ((url: string) => Promise<string>) | undefined;
  private readonly offload: Offload | undefined;
  /** Who waits for whom right now (placeholders for nodes, nodes for placeholders), to find cycles. */
  private readonly waits = new Map<string, Set<string>>();
  private holders = 0;

  constructor(options: { fetchText?: (url: string) => Promise<string>; offload?: Offload } = {}) {
    this.fetchText = options.fetchText;
    this.offload = options.offload;
  }

  /** Files asked for so far (for progress). */
  get known(): number { return this.composed.size; }

  /** A file with its scene complete. */
  load(url: string): Promise<ColladaDoc> {
    const abs = new URL(url, globalThis.location?.href ?? 'file:///').href;
    const key = fileKey(abs);
    let doc = this.docs.get(key);
    if (!doc) {
      doc = this.open(abs).then(async d => { await d.fillRoot(); return d; });
      this.docs.set(key, doc);
    }
    return doc;
  }

  /** A file composed; its placeholders are filled on demand. */
  private open(abs: string) {
    const key = fileKey(abs);
    let doc = this.composed.get(key);
    if (!doc) { doc = this.read(abs); this.composed.set(key, doc); }
    return doc;
  }

  /** Each problem once: a missing file is used by many instances. */
  private problem(text: string): void {
    if (!this.stats.missing.includes(text)) this.stats.missing.push(text);
  }

  /** Runs `work` as `from` waiting for `to`, unless `to` already waits for `from` (a cycle). */
  private async wait<T>(from: string, to: string, work: () => Promise<T>): Promise<T> {
    const reaches = (a: string, b: string, seen = new Set<string>()): boolean => {
      if (a === b) return true;
      if (seen.has(a)) return false;
      seen.add(a);
      for (const next of this.waits.get(a) ?? []) if (reaches(next, b, seen)) return true;
      return false;
    };
    if (reaches(to, from)) throw new Error('reference cycle');
    let edges = this.waits.get(from);
    if (!edges) this.waits.set(from, edges = new Set());
    edges.add(to);
    try {
      return await work();
    } finally {
      edges.delete(to);
      if (!edges.size) this.waits.delete(from);
    }
  }

  private async read(url: string): Promise<ColladaDoc & { fillRoot(): Promise<void> }> {
    const { text: patched, reduced, arrays, refs, bytes, ms } = this.offload ? await this.offload.load(url) : await loadFile(url, this.fetchText);
    const target = (ref: NodeRef) => (ref.file ? new URL(ref.file, url).href : url);
    // Ask for the referenced files now, so that they load while this one is being built.
    for (const ref of refs) if (ref.file && fileKey(target(ref)) !== fileKey(url)) this.open(target(ref)).catch(() => {});
    let t0 = performance.now();
    const parsed = patched.trim() ? new ArrayColladaParser(arrays).parse(patched) : null;
    if (!parsed) throw new Error('not a readable COLLADA document');
    const { library, asset, collada } = parsed;
    const parseMs = performance.now() - t0;
    if (this.offload) {
      // Skinned geometries are left to the composer here: it adds the skin to their
      // sources while composing, after a worker would have built them.
      const skinned = new Set(Object.values((library.controllers ?? {}) as Record<string, { id?: string; skin?: unknown }>).filter(c => c.skin).map(c => c.id));
      const geometries = library.geometries as Record<string, { build?: unknown }>;
      const toBuild = Object.fromEntries(Object.entries(geometries).filter(([id]) => !skinned.has(id)));
      const built = await this.offload.buildGeometries(toBuild);
      for (const [id, b] of Object.entries(built)) geometries[id].build = toThree(b);
    }
    t0 = performance.now();
    const composer = new PrebuiltColladaComposer(library, collada, new THREE.TextureLoader().setPath(dirOf(url)), new TGALoader().setPath(dirOf(url)));
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

    // Each placeholder is filled once, whoever asks first (the scene or a node that
    // contains it); the others wait for the same fill. `filled` is also copied with a
    // node, so a copy of a placeholder that could not be filled is not taken for one of
    // this file.
    const filling = new WeakMap<THREE.Object3D, { id: string; done: Promise<void> }>();
    const fillOne = async (holder: THREE.Object3D, ref: NodeRef, id: string) => {
      const where = `${ref.file}#${ref.id}`;
      let source: THREE.Object3D | null = null;
      let sourceDoc: ColladaDoc = doc;
      let problem = 'not found';
      try {
        if (fileKey(target(ref)) !== fileKey(url)) sourceDoc = await this.open(target(ref));
        source = await this.wait(id, nodeKey(sourceDoc.url, ref.id), () => sourceDoc.node(ref.id));
      } catch (e) {
        problem = `(${(e as Error).message})`;
      }
      if (!source) {
        this.problem(`${baseName(url)}: ${where} ${problem}`);
        holder.name = `missing ${where}`;
        return;
      }
      const copy = source.clone(true);
      holder.name = `instance ${where}`;
      if (sourceDoc.unit !== doc.unit) {
        const wrapper = new THREE.Group();
        wrapper.scale.setScalar(sourceDoc.unit / doc.unit);
        wrapper.add(copy);
        holder.add(wrapper);
      } else holder.add(copy);
    };
    const fill = async (object: THREE.Object3D, owner: string) => {
      const pending: { id: string; done: Promise<void> }[] = [];
      object.traverse(o => {
        let job = filling.get(o);
        if (!job) {
          const m = PLACEHOLDER.exec(o.name ?? '');
          if (!m || o.userData.filled) return;
          o.userData.filled = true;
          const id = `${url}|holder ${this.holders++}`;
          job = { id, done: fillOne(o, refs[+m[1]], id) };
          filling.set(o, job);
        }
        pending.push(job);
      });
      await Promise.all(pending.map(job => this.wait(owner, job.id, () => job.done)
        .catch(() => this.problem(`${baseName(url)}: ${owner.split('|').pop()} contains itself (reference cycle)`))));
    };

    const built = new Map<string, Promise<THREE.Object3D | null>>();
    const doc: ColladaDoc & { fillRoot(): Promise<void> } = {
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
            await fill(object, nodeKey(url, id));
            return object;
          })();
          built.set(id, b);
        }
        return b;
      },
      fillRoot: () => fill(root, `${url}|scene`),
    };
    tag(root);
    return doc;
  }
}
