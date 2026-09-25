// Kinematics of a COLLADA 1.5 document: joints from <library_joints> and
// <kinematics_model>, the chain from nested <link>/<attachment_full>, and the binding of
// each joint to a transform element of a visual node through
// <scene><instance_kinematics_scene><bind_joint_axis>. Parameters are followed along
// <newparam sid> (with <SIDREF>, <float>, <int>) and <bind symbol><param ref>.

import * as THREE from 'three';

export interface Transform {
  kind: 'translate' | 'rotate' | 'scale' | 'matrix';
  sid: string | null;
  values: number[];
}

export interface Joint {
  /** Joint sid in its kinematics model. */
  sid: string;
  /** "<modelId>/<sid>", unique in the document. */
  key: string;
  name: string;
  type: 'revolute' | 'prismatic';
  axis: number[];
  min: number | null;
  max: number | null;
  /** Key of the joint this one hangs on, null for the first joints of the chain. */
  parent: string | null;
  /** Visual node driven by the joint (the node of the link it moves). */
  nodeId: string;
  /** The node's transform list; the element with `transformSid` is the joint's. */
  transforms: Transform[];
  transformSid: string;
  /** Value stored in the file (degrees or file units). The visual scene shows this pose. */
  initial: number;
}

export interface Kinematics {
  /** Bound joints, parents before children. */
  joints: Joint[];
  /** Joint key -> key of the joint it hangs on (also for joints that are not bound). */
  parentOf: Map<string, string | null>;
  problems: string[];
}

const children = (el: Element, name: string) => Array.from(el.children).filter(c => c.localName === name);
const child = (el: Element | undefined | null, name: string) => (el ? children(el, name)[0] : undefined);
const numbers = (s: string) => s.trim().split(/\s+/).map(Number);
const TRANSFORMS = ['translate', 'rotate', 'scale', 'matrix'];

export function hasKinematics(text: string): boolean {
  return /<instance_kinematics_scene\b/.test(text);
}

export function readKinematics(text: string): Kinematics {
  const xml = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  const all = (name: string) => Array.from(xml.getElementsByTagName(name));

  // Joint definitions by id. Some exporters write id="axis" instead of sid="axis".
  type JointDef = Pick<Joint, 'name' | 'type' | 'axis' | 'min' | 'max'>;
  const jointDefs = new Map<string, JointDef>();
  for (const j of all('joint')) {
    const id = j.getAttribute('id');
    if (!id) continue;
    const motion = Array.from(j.children).find(c => c.localName === 'revolute' || c.localName === 'prismatic');
    if (!motion) continue;
    const limits = child(motion, 'limits');
    const num = (n: string) => { const e = child(limits, n); return e ? parseFloat(e.textContent ?? '') : null; };
    jointDefs.set(id, {
      name: j.getAttribute('name') || id,
      type: motion.localName as Joint['type'],
      axis: numbers(child(motion, 'axis')?.textContent || '0 0 1'),
      min: num('min'),
      max: num('max'),
    });
  }

  // Joints of each kinematics model by sid (inline <joint sid> or <instance_joint sid url>).
  const modelJoints = new Map<string, Map<string, JointDef | undefined>>();
  for (const model of all('kinematics_model')) {
    const map = new Map<string, JointDef | undefined>();
    const tc = child(model, 'technique_common');
    if (tc) for (const c of Array.from(tc.children)) {
      const sid = c.getAttribute('sid');
      if (!sid) continue;
      if (c.localName === 'instance_joint') map.set(sid, jointDefs.get((c.getAttribute('url') || '').replace(/^#/, '')));
      else if (c.localName === 'joint') map.set(sid, jointDefs.get(c.getAttribute('id') ?? ''));
    }
    modelJoints.set(model.getAttribute('id') ?? '', map);
  }

  // The chain: which joint each joint hangs on.
  const parentOf = new Map<string, string | null>();
  for (const model of all('kinematics_model')) {
    const modelId = model.getAttribute('id');
    const walk = (link: Element, parentKey: string | null) => {
      for (const att of children(link, 'attachment_full')) {
        const key = `${modelId}/${(att.getAttribute('joint') || '').split('/').pop()}`;
        parentOf.set(key, parentKey);
        for (const next of children(att, 'link')) walk(next, key);
      }
    };
    const tc = child(model, 'technique_common');
    if (tc) for (const link of children(tc, 'link')) walk(link, null);
  }

  // Parameters are declared with <newparam sid> and passed on with <bind symbol>.
  const params = new Map<string, Element>();
  for (const p of all('newparam')) params.set(p.getAttribute('sid') ?? '', p);
  const binds = new Map<string, Element>();
  for (const b of all('bind')) { const s = b.getAttribute('symbol'); if (s) binds.set(s, b); }
  const sidOwners = new Map<string, Element>();
  for (const el of all('*')) { const sid = el.getAttribute('sid'); if (sid) sidOwners.set(sid, el); }

  type Resolved = JointDef & { sid: string; key: string };

  // A SIDREF like "kin_scene/inst_model/Joint_1/axis" ends in "<jointSid>/<axis sid>";
  // the element with sid "inst_model" names the model through its url.
  function jointFromSidref(sidref: string, depth: number): Resolved | null {
    const parts = sidref.trim().split('/');
    if (parts.length >= 3) {
      const jointSid = parts[parts.length - 2];
      const modelId = sidOwners.get(parts[parts.length - 3])?.getAttribute('url')?.replace(/^#/, '') ?? '';
      const joint = modelJoints.get(modelId)?.get(jointSid);
      if (joint) return { ...joint, sid: jointSid, key: `${modelId}/${jointSid}` };
    }
    return resolveJoint(parts[parts.length - 1], depth + 1);
  }

  function resolveJoint(name: string, depth = 0): Resolved | null {
    if (depth > 8) return null;
    const holder = params.get(name) || binds.get(name);
    if (!holder) return null;
    const sidref = child(holder, 'SIDREF');
    if (sidref) return jointFromSidref(sidref.textContent ?? '', depth);
    const ref = child(holder, 'param')?.getAttribute('ref');
    return ref ? resolveJoint(ref, depth + 1) : null;
  }

  function resolveValue(name: string, depth = 0): number {
    const holder = params.get(name) || binds.get(name);
    if (!holder || depth > 8) return 0;
    const f = child(holder, 'float') || child(holder, 'int');
    if (f) return parseFloat(f.textContent ?? '');
    const ref = child(holder, 'param')?.getAttribute('ref');
    return ref ? resolveValue(ref, depth + 1) : 0;
  }

  const nodesById = new Map<string, Element>();
  for (const n of all('node')) { const id = n.getAttribute('id'); if (id) nodesById.set(id, n); }
  const nodeTransforms = (nodeId: string): Transform[] | null => {
    const node = nodesById.get(nodeId);
    return node ? Array.from(node.children)
      .filter(c => TRANSFORMS.includes(c.localName))
      .map(c => ({ kind: c.localName as Transform['kind'], sid: c.getAttribute('sid'), values: numbers(c.textContent ?? '') })) : null;
  };

  const joints: Joint[] = [];
  const problems: string[] = [];
  for (const scene of all('instance_kinematics_scene')) {
    for (const bind of children(scene, 'bind_joint_axis')) {
      const target = bind.getAttribute('target') || '';
      const [nodeId, transformSid] = target.split('/');
      const axisParam = child(child(bind, 'axis') ?? bind, 'param')?.textContent?.trim();
      const valueParam = child(child(bind, 'value') ?? bind, 'param')?.textContent?.trim();
      const joint = axisParam ? resolveJoint(axisParam) : null;
      const transforms = nodeTransforms(nodeId);
      if (!joint || !transforms || !transforms.some(t => t.sid === transformSid)) {
        problems.push(`${target}: ${!joint ? 'joint not resolved' : 'target transform not found'}`);
        continue;
      }
      joints.push({
        ...joint,
        parent: parentOf.get(joint.key) ?? null,
        nodeId,
        transforms,
        transformSid,
        initial: valueParam ? resolveValue(valueParam) : 0,
      });
    }
  }
  const depth = (j: Joint) => { let d = 0; for (let k = j.parent; k; k = parentOf.get(k) ?? null) d++; return d; };
  joints.sort((a, b) => depth(a) - depth(b));
  return { joints, parentOf, problems };
}

function elementMatrix(tr: Transform): THREE.Matrix4 {
  const v = tr.values;
  const t = new THREE.Matrix4();
  if (tr.kind === 'translate') t.makeTranslation(v[0], v[1], v[2]);
  else if (tr.kind === 'rotate') t.makeRotationAxis(new THREE.Vector3(v[0], v[1], v[2]).normalize(), THREE.MathUtils.degToRad(v[3]));
  else if (tr.kind === 'scale') t.makeScale(v[0], v[1], v[2]);
  else t.fromArray(v).transpose();
  return t;
}

/**
 * Frame of the transform element a joint is bound to, in the node's parent space: the
 * product of the node's transforms that come before it. The joint axis is the element's
 * axis in this frame.
 */
export function jointFrame(joint: Joint): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  for (const tr of joint.transforms) {
    if (tr.sid === joint.transformSid) break;
    m.multiply(elementMatrix(tr));
  }
  return m;
}

/** Motion of a joint by `delta` (degrees or file units) in its own frame. */
export function jointMotion(joint: Joint, delta: number): THREE.Matrix4 {
  const tr = joint.transforms.find(t => t.sid === joint.transformSid)!;
  const axis = new THREE.Vector3(tr.values[0], tr.values[1], tr.values[2]);
  if (tr.kind !== 'rotate' && tr.kind !== 'translate' || axis.lengthSq() === 0) axis.set(joint.axis[0], joint.axis[1], joint.axis[2]);
  axis.normalize();
  return joint.type === 'revolute'
    ? new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(delta))
    : new THREE.Matrix4().makeTranslation(axis.x * delta, axis.y * delta, axis.z * delta);
}
