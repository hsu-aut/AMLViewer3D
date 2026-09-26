// Rewrites applied to a COLLADA document before three.js parses it. Each one works around
// something three.js' COLLADA parser (r186) does not handle the way AML files need, or
// makes loading faster:
//
//  - Number lists (<float_array>, <p>, <vcount>) are most of a file. They are read into
//    typed arrays here and replaced by a short token, so the XML parser only sees the
//    markup (see parser.ts for the other half).
//  - <tristrips> and <trifans> are ignored by three.js; they become <triangles>.
//    <polygons> with one <p> per polygon keeps only the last polygon in three.js; it
//    becomes <polylist>.
//  - <instance_node>: three.js resolves only references inside the file, and when a node
//    holds exactly one instance it merges the two and loses the inner node's name and
//    transform. Every <instance_node> becomes a placeholder node, filled afterwards (see
//    store.ts) with a copy of the referenced node from this or another file.
//  - Nodes without id overwrite each other in three.js' node table; they get one. Nodes
//    with only a sid (attachment points, frames of interest) keep the sid as id.
//  - Names survive copying inside three.js, so every node's name carries its id.
//  - three.js' own kinematics fails on real files; <instance_kinematics_scene> is removed
//    and read separately (kinematics.ts) from `reduced`.

import { parseFloatList, parseIntList } from './numbers';

export const NODE_TAG = '@';
export const PLACEHOLDER = /^@__ref_(\d+)$/;
export const ARRAY_TOKEN = /^\s*§(\d+)\s*$/;

export interface NodeRef {
  /** File part of the url, empty for a node in the same file. */
  file: string;
  id: string;
}

export type NumberArray = Float32Array | Int32Array;

export interface Preprocessed {
  /** The document for three.js: tokens instead of number lists, all rewrites applied. */
  text: string;
  /** The document with tokens instead of number lists and nothing else changed. */
  reduced: string;
  arrays: NumberArray[];
  refs: NodeRef[];
}

const INSTANCE_NODE = /<instance_node\b[^>]*?\burl="([^"#]*)#([^"]*)"[^>]*?(?:\/>|>[\s\S]*?<\/instance_node>)/g;
const NUMBER_LIST = /<(float_array|p|vcount)\b([^>]*)>([^<]*)<\/\1>/g;
const token = (k: number) => `§${k}`;

export function preprocess(source: string): Preprocessed {
  const arrays: NumberArray[] = [];
  const reduced = source.replace(/^﻿/, '').replace(NUMBER_LIST, (_m, tag: string, attrs: string, body: string) => {
    arrays.push(tag === 'float_array' ? parseFloatList(body) : parseIntList(body));
    return `<${tag}${attrs}>${token(arrays.length - 1)}</${tag}>`;
  });
  // Takes a list out: strips, fans and polygons are rewritten into new lists, and the old
  // ones would otherwise still be handed from the worker to the page.
  const take = (p: string) => {
    const k = +(ARRAY_TOKEN.exec(p)?.[1] ?? NaN);
    const list = arrays[k] as Int32Array | undefined;
    if (list) arrays[k] = new Int32Array(0);
    return list;
  };

  const refs: NodeRef[] = [];
  let anonymous = 0;
  const text = reduced
    .replace(/<(tristrips|trifans)\b([^>]*)>([\s\S]*?)<\/\1>/g, (_m, kind: string, attrs: string, body: string) => {
      const inputs = body.match(/<input\b[^>]*\/>/g) || [];
      const lists = [...body.matchAll(/<p>([^<]*)<\/p>/g)].map(m => take(m[1]) ?? new Int32Array(0));
      const indices = stripIndices(kind as 'tristrips' | 'trifans', lists, strideOf(inputs));
      arrays.push(indices);
      const rest = attrs.replace(/\s+count="[^"]*"/, '');
      return `<triangles${rest} count="${indices.length / strideOf(inputs) / 3}">${inputs.join('')}<p>${token(arrays.length - 1)}</p></triangles>`;
    })
    .replace(/<polygons\b([^>]*)>([\s\S]*?)<\/polygons>/g, (_m, attrs: string, body: string) => {
      const inputs = body.match(/<input\b[^>]*\/>/g) || [];
      const stride = strideOf(inputs);
      const lists = [...body.matchAll(/<p>([^<]*)<\/p>/g)].map(m => take(m[1]) ?? new Int32Array(0));
      const vcount = Int32Array.from(lists, l => l.length / stride);
      const p = new Int32Array(lists.reduce((n, l) => n + l.length, 0));
      let at = 0;
      for (const l of lists) { p.set(l, at); at += l.length; }
      arrays.push(vcount, p);
      const rest = attrs.replace(/\s+count="[^"]*"/, '');
      return `<polylist${rest} count="${lists.length}">${inputs.join('')}<vcount>${token(arrays.length - 2)}</vcount><p>${token(arrays.length - 1)}</p></polylist>`;
    })
    .replace(INSTANCE_NODE, (_m, file: string, id: string) => {
      refs.push({ file, id });
      return `<node id="__ref_${refs.length - 1}"/>`;
    })
    .replace(/<instance_kinematics_scene\b[\s\S]*?<\/instance_kinematics_scene>/g, '')
    .replace(/<node\b(?![^>]*\bid=)([^>]*)\bsid="([^"]+)"/g, '<node id="sid:$2"$1sid="$2"')
    .replace(/<node\b([^>]*?)(\/?)>/g, (_tag, attrs: string, slash: string) => {
      let id = /\bid="([^"]*)"/.exec(attrs)?.[1];
      if (!id) { id = `__node_${anonymous++}`; attrs = ` id="${id}"${attrs}`; }
      return `<node${attrs.replace(/\s+name="[^"]*"/, '')} name="${NODE_TAG}${id}"${slash}>`;
    });
  return { text, reduced, arrays, refs };
}

function strideOf(inputs: string[]): number {
  return Math.max(0, ...inputs.map(i => Number(/\boffset="(\d+)"/.exec(i)?.[1] ?? 0))) + 1;
}

/**
 * Triangle indices of strips or fans. Each list holds whole vertices of `stride` indices.
 * A strip v0 v1 v2 v3 … gives (v0 v1 v2), (v2 v1 v3), … so that all triangles keep the
 * winding of the first; a fan gives (v0 v1 v2), (v0 v2 v3), …. Triangles with a repeated
 * vertex (joins between strips) are dropped.
 */
export function stripIndices(kind: 'tristrips' | 'trifans', lists: Int32Array[], stride: number): Int32Array {
  let capacity = 0;
  for (const l of lists) capacity += Math.max(0, l.length / stride - 2) * 3 * stride;
  const out = new Int32Array(capacity);
  let n = 0;
  const same = (l: Int32Array, a: number, b: number) => {
    for (let k = 0; k < stride; k++) if (l[a * stride + k] !== l[b * stride + k]) return false;
    return true;
  };
  for (const l of lists) {
    const count = Math.floor(l.length / stride);
    for (let i = 0; i + 2 < count; i++) {
      const [a, b, c] = kind === 'trifans' ? [0, i + 1, i + 2] : i % 2 === 0 ? [i, i + 1, i + 2] : [i + 1, i, i + 2];
      if (same(l, a, b) || same(l, b, c) || same(l, a, c)) continue;
      for (const v of [a, b, c]) for (let k = 0; k < stride; k++) out[n++] = l[v * stride + k];
    }
  }
  return out.slice(0, n);
}
