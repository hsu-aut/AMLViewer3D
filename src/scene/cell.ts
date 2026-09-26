// Builds a three.js scene from an AML document and its COLLADA files (AutomationML Part 3).
//
//  - Every InternalElement becomes a group placed by its Frame (metres, degrees, relative
//    to the parent element).
//  - An "explicit" COLLADAInterface draws the referenced file (or node) in that group.
//  - An "implicit" one points at a node that already belongs to another element's
//    geometry (for example axis 6 of a robot). It is not drawn again; clicks on that node
//    select the element, and the element's AML children move with the node.
//  - Joints come from the COLLADA kinematics. Moving a joint moves every link below it in
//    the kinematic chain, relative to the pose stored in the file.
//  - Attachment links (InternalLinks between AttachmentInterfaces) let a part follow the
//    machine link it is mounted on.

import * as THREE from 'three';
import type { AmlDocument, AmlElement } from '../aml/reader';
import { ColladaStore, nodeKey, type ColladaDoc } from '../collada/store';
import { jointFrame, jointMotion, type Joint } from '../collada/kinematics';
import { frameMatrix } from './frame';

export interface CellElement {
  el: AmlElement;
  group: THREE.Group;
  /** Geometry drawn for this element (explicit reference), scaled to metres. */
  instance: THREE.Group | null;
  doc: ColladaDoc | null;
  /** Node inside another element's geometry that this element stands for (implicit reference). */
  mapped: THREE.Object3D | null;
}

export interface CellJoint extends Joint {
  object: THREE.Object3D;
  value: number;
  mechanism: Mechanism;
  initialRel: THREE.Matrix4;
  frame: THREE.Matrix4;
  frameInv: THREE.Matrix4;
  depth: number;
}

export interface Mechanism {
  element: AmlElement;
  entry: CellElement;
  /** The drawn file's root, in file units. */
  space: THREE.Object3D;
  joints: CellJoint[];
  parentOf: Map<string, string | null>;
  byDepth: CellJoint[];
}

export interface Attachment {
  name: string | null;
  leader: CellElement;
  follower: CellElement;
  offset: THREE.Matrix4;
}

export interface Cell {
  aml: AmlDocument;
  world: THREE.Group;
  elements: Map<string, CellElement>;
  mechanisms: Mechanism[];
  attachments: Attachment[];
  problems: string[];
  setJoint(joint: CellJoint, value: number): void;
  resetJoints(mechanism?: Mechanism): void;
  attachmentPoint(el: AmlElement): THREE.Object3D | null;
}

/**
 * The URL of a file an AML document refers to. A path on a drive ("file:///C:/Col/x.dae"
 * or "C:\Col\x.dae") can be read only when the host serves that drive, as the editor
 * plugin does for an .aml file: `drive` is then its letter ("C:") and the served root is
 * the root of the document's URL.
 */
export function fileUrl(file: string, amlUrl: string, drive?: string | null): string {
  const onDrive = /^(?:file:\/\/\/)?([A-Za-z]):[\\/](.*)$/.exec(file);
  if (!onDrive) return new URL(file, amlUrl).href;
  if (drive && drive[0].toLowerCase() === onDrive[1].toLowerCase()) return new URL('/' + onDrive[2].replace(/\\/g, '/'), amlUrl).href;
  throw new Error(drive
    ? `${file} is on another drive than the document (${drive.toUpperCase()}); move it next to the document`
    : `${file} is an absolute path; only files relative to the document can be read here`);
}

export async function buildCell(aml: AmlDocument, amlUrl: string, store: ColladaStore, options: { frameOrder?: 'fixed' | 'moving'; drive?: string | null } = {}): Promise<Cell> {
  const order = options.frameOrder ?? 'fixed';
  const world = new THREE.Group();
  world.name = 'AML cell';
  const elements = new Map<string, CellElement>();
  const problems: string[] = [];
  const all: CellElement[] = [];

  async function place(el: AmlElement, parentGroup: THREE.Object3D): Promise<void> {
    const group = new THREE.Group();
    group.name = el.name;
    group.userData.amlId = el.id;
    if (el.frame) frameMatrix(el.frame, order).decompose(group.position, group.quaternion, group.scale);
    parentGroup.add(group);
    const entry: CellElement = { el, group, instance: null, doc: null, mapped: null };
    elements.set(el.id, entry);
    all.push(entry);

    const jobs: Promise<void>[] = [];
    const explicit = el.collada.find(c => c.refType === 'explicit');
    if (explicit) jobs.push((async () => {
      try {
        const doc = await store.load(fileUrl(explicit.file, amlUrl, options.drive));
        const source = explicit.fragment ? await doc.node(explicit.fragment) : doc.root;
        if (!source) throw new Error(`node #${explicit.fragment} not found`);
        const instance = new THREE.Group();
        instance.name = `geometry ${doc.name}`;
        instance.scale.setScalar(doc.unit);
        instance.add(source.clone(true));
        group.add(instance);
        entry.instance = instance;
        entry.doc = doc;
      } catch (e) {
        problems.push(`${el.name}: ${explicit.uri}: ${(e as Error).message}`);
      }
    })());
    jobs.push(...el.children.map(c => place(c, group)));
    await Promise.all(jobs);
  }

  for (const ih of aml.hierarchies) for (const el of ih.children) await place(el, world);

  const findIn = (root: THREE.Object3D | null | undefined, key: string) => {
    let found: THREE.Object3D | null = null;
    root?.traverse(o => { if (!found && o.userData.nodeKey === key) found = o; });
    return found as THREE.Object3D | null;
  };

  // Implicit references: find the node inside the nearest ancestor's geometry.
  for (const entry of all) {
    const ref = entry.el.collada.find(c => c.refType === 'implicit' && c.fragment && !c.target);
    if (!ref) continue;
    const key = nodeKey(ref.file, ref.fragment!);
    let found: THREE.Object3D | null = null;
    for (let p = entry.el.parent; p && !found; p = p.parent) found = findIn(elements.get(p.id)?.instance, key);
    if (found) { found.userData.amlId = entry.el.id; entry.mapped = found; }
    else problems.push(`${entry.el.name}: implicit node ${key} not found in any parent geometry`);
  }

  // Attachment point of a frame element: the COLLADA node named by `target` (a sid,
  // relative to the referenced node) inside the nearest ancestor's geometry, or the
  // element's own Frame when it has no COLLADA reference.
  function attachmentPoint(el: AmlElement): THREE.Object3D | null {
    const ref = el.collada.find(c => c.refType === 'implicit' && c.target);
    if (!ref) return elements.get(el.id)?.group ?? null;
    const key = nodeKey(ref.file, 'sid:' + ref.target!.replace(/^\.\//, ''));
    for (let p = el.parent; p; p = p.parent) {
      const found = findIn(elements.get(p.id)?.instance, key);
      if (found) return found;
    }
    return null;
  }

  // Mechanisms. The file shows the machine at its stored joint values. Changing a joint by
  // delta moves every link below it in the chain about the joint's axis. Poses are set
  // relative to the stored pose, so this works whether the visual nodes are nested like
  // the chain or flat siblings (as in the KUKA files of the robot cell).
  world.updateMatrixWorld(true);
  const mechanisms: Mechanism[] = [];
  for (const entry of all) {
    const kin = entry.doc?.kinematics;
    if (!kin || !entry.instance) continue;
    const space = entry.instance.children[0];
    const spaceInv = space.matrixWorld.clone().invert();
    const rel = (o: THREE.Object3D) => spaceInv.clone().multiply(o.matrixWorld);
    const mechanism: Mechanism = { element: entry.el, entry, space, joints: [], parentOf: kin.parentOf, byDepth: [] };
    for (const j of kin.joints) {
      const object = findIn(space, nodeKey(entry.doc!.url, j.nodeId));
      if (!object || !object.parent) { problems.push(`${entry.el.name}: joint ${j.name} drives node ${j.nodeId}, not found`); continue; }
      object.userData.jointDriven = true;
      const frame = rel(object.parent).multiply(jointFrame(j));
      let depth = 0;
      for (let o: THREE.Object3D | null = object; o && o !== space; o = o.parent) depth++;
      mechanism.joints.push({ ...j, object, value: j.initial, mechanism, initialRel: rel(object), frame, frameInv: frame.clone().invert(), depth });
    }
    problems.push(...kin.problems.map(p => `${entry.el.name}: ${p}`));
    if (!mechanism.joints.length) continue;
    mechanism.byDepth = [...mechanism.joints].sort((a, b) => a.depth - b.depth);
    mechanisms.push(mechanism);
  }

  function poseMechanism(m: Mechanism) {
    const motion = new Map<string, THREE.Matrix4>();
    const motionOf = (key: string | null) => {
      for (let k = key; k; k = m.parentOf.get(k) ?? null) { const found = motion.get(k); if (found) return found; }
      return new THREE.Matrix4();
    };
    for (const j of m.joints) {                                     // parents first
      motion.set(j.key, motionOf(j.parent).clone().multiply(j.frame).multiply(jointMotion(j, j.value - j.initial)).multiply(j.frameInv));
    }
    m.space.updateWorldMatrix(true, false);
    for (const j of m.byDepth) {                                    // visual parents first
      const target = m.space.matrixWorld.clone().multiply(motion.get(j.key)!).multiply(j.initialRel);
      j.object.parent!.updateWorldMatrix(true, false);
      j.object.matrixAutoUpdate = false;
      j.object.matrix.copy(j.object.parent!.matrixWorld.clone().invert().multiply(target));
      j.object.updateMatrixWorld(true);
    }
  }

  // Elements that stand for a node inside a machine carry their AML children (frames,
  // attachment points) along when that node moves. Scale is dropped: the node lives in
  // file units, the AML tree in metres.
  const implicitEntries = all.filter(e => e.mapped);
  function followNodes() {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (const e of implicitEntries) {
      e.mapped!.updateWorldMatrix(true, false);
      e.mapped!.matrixWorld.decompose(p, q, s);
      e.group.parent!.updateWorldMatrix(true, false);
      e.group.parent!.matrixWorld.clone().invert()
        .multiply(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)))
        .decompose(e.group.position, e.group.quaternion, e.group.scale);
      e.group.updateMatrixWorld(true);
    }
  }

  // Attachments: the leader is the side that sits on a joint-driven node; the follower is
  // a part with its own geometry, or a part that sits unmoved inside the machine's file
  // (like a tool on the flange). The owner of an attachment frame is its parent element.
  const moving = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.jointDriven) return true; return false; };
  const objectOf = (e: CellElement) => e.mapped ?? e.group;
  const attachments: Attachment[] = [];
  for (const link of aml.links) {
    if (link.sideA?.kind !== 'AttachmentInterface' || link.sideB?.kind !== 'AttachmentInterface') continue;
    const a = link.sideA.element.parent && elements.get(link.sideA.element.parent.id);
    const b = link.sideB.element.parent && elements.get(link.sideB.element.parent.id);
    if (!a || !b || a === b) continue;
    const aMoves = !!a.mapped && moving(a.mapped), bMoves = !!b.mapped && moving(b.mapped);
    if (aMoves === bMoves) continue;
    const [leader, follower] = aMoves ? [a, b] : [b, a];
    attachments.push({ name: link.name, leader, follower, offset: leader.mapped!.matrixWorld.clone().invert().multiply(objectOf(follower).matrixWorld) });
  }

  function update() {
    for (let pass = 0; pass < 3; pass++) {                         // chains: carriage, robot, gripper
      for (const m of mechanisms) poseMechanism(m);
      followNodes();
      for (const at of attachments) {
        const object = objectOf(at.follower);
        object.parent!.updateWorldMatrix(true, false);
        object.parent!.matrixWorld.clone().invert()
          .multiply(at.leader.mapped!.matrixWorld.clone().multiply(at.offset))
          .decompose(object.position, object.quaternion, object.scale);
        object.matrixAutoUpdate = true;
        object.updateMatrixWorld(true);
      }
    }
  }

  return {
    aml, world, elements, mechanisms, attachments, problems, attachmentPoint,
    setJoint(joint, value) { joint.value = value; update(); },
    resetJoints(mechanism) {
      for (const m of mechanism ? [mechanism] : mechanisms) for (const j of m.joints) j.value = j.initial;
      update();
    },
  };
}

/** The AML element id of a picked object: the nearest object that carries one. */
export function elementOf(object: THREE.Object3D | null): string | null {
  for (let o = object; o; o = o.parent) if (o.userData.amlId) return o.userData.amlId as string;
  return null;
}
