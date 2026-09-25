// Work that needs no DOM and can therefore run in a Web Worker: reading and preprocessing
// a COLLADA file, and building its geometries from the parsed data. The functions here
// are plain so that tests can run them without workers (see test/offload.test.ts);
// worker.ts wraps them, pool.ts spreads them over several workers.

import * as THREE from 'three';
import { ColladaComposer } from 'three/addons/loaders/collada/ColladaComposer.js';
import type { ColladaLibrary } from 'three/addons/loaders/collada/ColladaParser.js';
import { preprocess, type Preprocessed } from './preprocess';

export interface LoadedFile extends Preprocessed {
  bytes: number;
  ms: number;
}

/** A geometry as three.js' composer builds it, one entry per primitive type, as plain data. */
export type BuiltGeometry = Record<string, {
  type: string;
  materialKeys: string[];
  attributes: Record<string, { array: Float32Array; itemSize: number }>;
  groups: { start: number; count: number; materialIndex?: number }[];
}>;

export interface Offload {
  load(url: string): Promise<LoadedFile>;
  buildGeometries(geometries: Record<string, unknown>): Promise<Record<string, BuiltGeometry>>;
}

export async function loadFile(url: string, fetchText: (url: string) => Promise<string> = defaultFetch): Promise<LoadedFile> {
  const text = await fetchText(url);
  const t0 = performance.now();
  const pre = preprocess(text);
  return { ...pre, bytes: text.length, ms: performance.now() - t0 };
}

async function defaultFetch(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

/** Buffers to hand over instead of copying. */
export function transferables(value: unknown, into: Transferable[] = []): Transferable[] {
  if (ArrayBuffer.isView(value)) { if (!into.includes(value.buffer as ArrayBuffer)) into.push(value.buffer as ArrayBuffer); }
  else if (Array.isArray(value)) for (const v of value) transferables(v, into);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) transferables(v, into);
  return into;
}

// The composer only needs the geometry part of the library to build geometries.
const composer = new ColladaComposer({ nodes: {}, geometries: {} } as unknown as ColladaLibrary, null as unknown as Element, null as unknown as THREE.TextureLoader, null);

export function buildGeometries(geometries: Record<string, unknown>): Record<string, BuiltGeometry> {
  const out: Record<string, BuiltGeometry> = {};
  for (const [id, data] of Object.entries(geometries)) {
    if (!data) continue;
    const build = (composer as unknown as { buildGeometry(d: unknown): Record<string, { data: THREE.BufferGeometry; type: string; materialKeys: string[] }> }).buildGeometry(data);
    const plain: BuiltGeometry = {};
    for (const [type, b] of Object.entries(build)) {
      const attributes: BuiltGeometry[string]['attributes'] = {};
      for (const [name, attr] of Object.entries(b.data.attributes)) {
        attributes[name] = { array: (attr as THREE.BufferAttribute).array as Float32Array, itemSize: (attr as THREE.BufferAttribute).itemSize };
      }
      plain[type] = { type: b.type, materialKeys: b.materialKeys, attributes, groups: b.data.groups.map(g => ({ ...g })) };
    }
    out[id] = plain;
  }
  return out;
}

/** The composer's build result for one geometry, from the plain data. */
export function toThree(built: BuiltGeometry): Record<string, { data: THREE.BufferGeometry; type: string; materialKeys: string[] }> {
  const out: Record<string, { data: THREE.BufferGeometry; type: string; materialKeys: string[] }> = {};
  for (const [type, b] of Object.entries(built)) {
    const geometry = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(b.attributes)) geometry.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize));
    for (const g of b.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    out[type] = { data: geometry, type: b.type, materialKeys: b.materialKeys };
  }
  return out;
}

/**
 * Runs the offload functions in this thread the way a worker would: arguments and results
 * are cloned, and typed arrays are handed over, so the sender's copies end up empty.
 */
const handOver = <T>(value: T): T => structuredClone(value, { transfer: transferables(value) });
export const inThread = (fetchText?: (url: string) => Promise<string>): Offload => ({
  load: async url => handOver(await loadFile(url, fetchText)),
  buildGeometries: async geometries => handOver(buildGeometries(handOver(geometries))),
});
