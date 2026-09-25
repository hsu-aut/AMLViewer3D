// Text rewrites applied to a COLLADA document before three.js parses it. Each one works
// around something three.js' COLLADA parser (r186) does not handle the way AML files need:
//
//  - <instance_node>: three.js resolves only references inside the file, and when a node
//    holds exactly one instance it merges the two and loses the inner node's name and
//    transform. Every <instance_node> becomes a placeholder node, filled afterwards (see
//    store.ts) with a copy of the referenced node from this or another file.
//  - Nodes without id overwrite each other in three.js' node table; they get one. Nodes
//    with only a sid (attachment points, frames of interest) keep the sid as id.
//  - Names do survive copying inside three.js, so every node's name carries its id.
//  - <tristrips> and <trifans> are ignored by three.js; they become <triangles>.
//  - three.js' own kinematics fails on real files; <instance_kinematics_scene> is removed
//    here and read separately (kinematics.ts).

export const NODE_TAG = '@';
export const PLACEHOLDER = /^@__ref_(\d+)$/;

export interface NodeRef {
  /** File part of the url, empty for a node in the same file. */
  file: string;
  id: string;
}

const INSTANCE_NODE = /<instance_node\b[^>]*?\burl="([^"#]*)#([^"]*)"[^>]*?(?:\/>|>[\s\S]*?<\/instance_node>)/g;

export function preprocess(text: string): { text: string; refs: NodeRef[] } {
  const refs: NodeRef[] = [];
  let anonymous = 0;
  const out = text
    .replace(/^﻿/, '')
    .replace(INSTANCE_NODE, (_, file: string, id: string) => {
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
  return { text: stripsToTriangles(out), refs };
}

/**
 * Rewrites <tristrips> and <trifans> as <triangles>. A strip v0 v1 v2 v3 … gives
 * (v0 v1 v2), (v2 v1 v3), … so that all triangles keep the winding of the first; a fan
 * gives (v0 v1 v2), (v0 v2 v3), …. Triangles with a repeated vertex (joins between strips)
 * are dropped.
 */
export function stripsToTriangles(text: string): string {
  return text.replace(/<(tristrips|trifans)\b([^>]*)>([\s\S]*?)<\/\1>/g, (_m, kind: string, attrs: string, body: string) => {
    const inputs = body.match(/<input\b[^>]*\/>/g) || [];
    const stride = Math.max(0, ...inputs.map(i => Number(/\boffset="(\d+)"/.exec(i)?.[1] ?? 0))) + 1;
    const out: string[] = [];
    for (const [, p] of body.matchAll(/<p>([^<]*)<\/p>/g)) {
      const idx = p.trim().split(/\s+/);
      const n = Math.floor(idx.length / stride);
      const vertex = (i: number) => idx.slice(i * stride, i * stride + stride).join(' ');
      for (let i = 0; i + 2 < n; i++) {
        const order = kind === 'trifans' ? [0, i + 1, i + 2] : i % 2 === 0 ? [i, i + 1, i + 2] : [i + 1, i, i + 2];
        const tri = order.map(vertex);
        if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
        out.push(tri.join(' '));
      }
    }
    const rest = attrs.replace(/\s+count="[^"]*"/, '');
    return `<triangles${rest} count="${out.length}">${inputs.join('')}<p>${out.join(' ')}</p></triangles>`;
  });
}
