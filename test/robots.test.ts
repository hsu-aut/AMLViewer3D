// Robots from three more COLLADA writers than the robot cell's (see scripts/fetch-robots.mjs;
// the files are not part of the repository): npm run test:robots.
//
//  - Every robot of rdiankov/collada_robots loads, and every joint of its kinematics finds the
//    node it moves.
//  - The robots of the OpenRAVE writer move as their own kinematics model says: forward
//    kinematics computed here from <link>/<attachment_full> moves every link like the scene.
//  - The robots converted from URDF with collada_urdf move as the URDF says, an independent
//    source in another format.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { ColladaStore } from '../src/collada/store';
import { parseAml } from '../src/aml/reader';
import { buildCell, type Cell, type Mechanism } from '../src/scene/cell';
import { fetchFile } from './helpers';

const robotsDir = path.resolve('data/collada-robots/dae');
const urdfDir = path.resolve('data/urdf');
const robots = fs.existsSync(robotsDir) ? fs.readdirSync(robotsDir) : [];
const urdfRobots = ['panda', 'ur5e', 'irb2400'].filter(r => fs.existsSync(path.join(urdfDir, `${r}.dae`)));

const daeIn = (dir: string) => fs.readdirSync(dir).find(f => f.endsWith('.dae'))!;
const aml = (file: string) => `<?xml version="1.0"?><CAEXFile SchemaVersion="3.0" FileName="r.aml" xmlns="http://www.dke.de/CAEX"><InstanceHierarchy Name="IH" ID="ih">
<InternalElement Name="Robot" ID="robot"><ExternalInterface Name="Rep" ID="rep" RefBaseClassPath="AutomationMLInterfaceClassLib/AutomationMLBaseInterface/ExternalDataConnector/COLLADAInterface">
<Attribute Name="refURI"><Value>${file}</Value></Attribute><Attribute Name="refType"><Value>explicit</Value></Attribute></ExternalInterface></InternalElement>
</InstanceHierarchy></CAEXFile>`;
const load = (dir: string, file: string) => {
  const store = new ColladaStore({ fetchText: fetchFile });
  return buildCell(parseAml(aml(file)), pathToFileURL(path.join(dir, 'r.aml')).href, store).then(cell => ({ cell, store }));
};

const kids = (el: Element, name: string) => Array.from(el.children).filter(c => c.localName === name);
const nums = (el: Element) => (el.textContent ?? '').trim().split(/\s+/).map(Number);
const own = (el: Element) => {
  const m = new THREE.Matrix4();
  for (const c of Array.from(el.children)) {
    const v = nums(c);
    if (c.localName === 'translate') m.multiply(new THREE.Matrix4().makeTranslation(v[0], v[1], v[2]));
    else if (c.localName === 'rotate') m.multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(v[0], v[1], v[2]).normalize(), THREE.MathUtils.degToRad(v[3])));
    else if (c.localName === 'matrix') m.multiply(new THREE.Matrix4().fromArray(v).transpose());
  }
  return m;
};

/** How far a point near the robot ends up apart under two motions. */
const apart = (a: THREE.Matrix4, b: THREE.Matrix4) => {
  const p = new THREE.Vector3(0.3, 0.2, 0.1);
  return p.clone().applyMatrix4(a).distanceTo(p.clone().applyMatrix4(b));
};

/** Deterministic joint values inside the limits. */
const valueFor = (i: number, lo: number, hi: number) => lo + ((i * 0.37 + 0.21) % 1) * (hi - lo);

/**
 * Motion of every joint's node between now and after `move`, relative to `base` (a node
 * that does not move), as a map by joint.
 */
function motions(m: Mechanism, base: THREE.Object3D, move: () => void) {
  m.space.updateWorldMatrix(true, true);
  const before = new Map(m.joints.map(j => [j, base.matrixWorld.clone().invert().multiply(j.object.matrixWorld)]));
  move();
  m.space.updateWorldMatrix(true, true);
  return new Map(m.joints.map(j => [j, base.matrixWorld.clone().invert().multiply(j.object.matrixWorld).multiply(before.get(j)!.clone().invert())]));
}

describe.skipIf(!robots.length)('collada_robots', () => {
  // kuka-kr360 (CATIA plug-in) names nodes that do not hold the joint's transform and has a
  // joint with two axes; both are not supported.
  const known = new Set(['kuka-kr360']);

  for (const name of robots) {
    it(`${name} loads with all its joints`, async () => {
      const dir = path.join(robotsDir, name);
      const text = fs.readFileSync(path.join(dir, daeIn(dir)), 'utf8');
      const { cell, store } = await load(dir, daeIn(dir));
      const bound = (text.match(/<bind_joint_axis\b/g) ?? []).length;
      const problems = [...store.stats.missing, ...cell.problems];
      if (known.has(name)) { expect(problems.length).toBeGreaterThan(0); return; }
      expect(problems).toEqual([]);
      expect(cell.mechanisms.reduce((n, m) => n + m.joints.length, 0)).toBe(bound);
    }, 120000);
  }

  for (const name of robots.filter(r => fs.readFileSync(path.join(robotsDir, r, daeIn(path.join(robotsDir, r))), 'utf8').includes('OpenRAVE Collada Writer'))) {
    it(`${name} moves as its kinematics model says`, async () => {
      const dir = path.join(robotsDir, name);
      const xml = new DOMParser().parseFromString(fs.readFileSync(path.join(dir, daeIn(dir)), 'utf8'), 'application/xml');
      const { cell } = await load(dir, daeIn(dir));
      const m = cell.mechanisms[0];
      const model = xml.getElementsByTagName('kinematics_model')[0];
      const tc = kids(model, 'technique_common')[0];
      const defs = new Map(kids(tc, 'joint').map(j => [j.getAttribute('sid')!, j]));
      const forward = (q: Map<string, number>) => {
        const frames = new Map<string, THREE.Matrix4>();
        const walk = (link: Element, parent: THREE.Matrix4) => {
          const frame = parent.clone().multiply(own(link));
          frames.set(link.getAttribute('sid')!, frame);
          for (const att of kids(link, 'attachment_full')) {
            const sid = (att.getAttribute('joint') ?? '').split('/').pop()!;
            const motion = Array.from(defs.get(sid)!.children).find(c => c.localName === 'revolute' || c.localName === 'prismatic')!;
            const axis = new THREE.Vector3(...nums(kids(motion, 'axis')[0]) as [number, number, number]).normalize();
            const v = q.get(sid) ?? 0;
            const move = motion.localName === 'revolute' ? new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(v)) : new THREE.Matrix4().makeTranslation(axis.x * v, axis.y * v, axis.z * v);
            for (const next of kids(att, 'link')) walk(next, frame.clone().multiply(own(att)).multiply(move));
          }
        };
        for (const link of kids(tc, 'link')) walk(link, new THREE.Matrix4());
        return frames;
      };
      const linkOf = new Map<string, string>();
      for (const att of Array.from(xml.getElementsByTagName('attachment_full'))) linkOf.set((att.getAttribute('joint') ?? '').split('/').pop()!, kids(att, 'link')[0].getAttribute('sid')!);

      // The base link's node: the one the kinematics model is bound to.
      const bindNode = (xml.getElementsByTagName('bind_kinematics_model')[0]?.getAttribute('node') ?? '').split('/').pop()!;
      const nodeId = Array.from(xml.getElementsByTagName('node')).find(n => n.getAttribute('sid') === bindNode || n.getAttribute('id') === bindNode)!.getAttribute('id')!;
      let base: THREE.Object3D = m.space;
      m.space.traverse(o => { if (o.userData.nodeKey?.endsWith('#' + nodeId)) base = o; });
      const rootLink = kids(tc, 'link')[0].getAttribute('sid')!;

      const q = new Map(m.joints.map((j, i) => [j.sid, valueFor(i, j.min ?? -90, j.max ?? 90)]));
      const rest = forward(new Map(m.joints.map(j => [j.sid, j.initial])));
      const moved = forward(q);
      const actual = motions(m, base, () => { for (const j of m.joints) cell.setJoint(j, q.get(j.sid)!); });
      const r0 = rest.get(rootLink)!;
      let worst = 0;
      for (const j of m.joints) {
        const link = linkOf.get(j.sid)!;
        const expected = r0.clone().invert().multiply(moved.get(link)!).multiply(rest.get(link)!.clone().invert()).multiply(r0);
        worst = Math.max(worst, apart(expected, actual.get(j)!));
      }
      expect(worst).toBeLessThan(1e-4);
    }, 120000);
  }
});

describe.skipIf(!urdfRobots.length)('robots converted from URDF with collada_urdf', () => {
  interface UJoint { name: string; type: string; parent: string; child: string; origin: THREE.Matrix4; axis: THREE.Vector3; lo: number; hi: number }
  const readUrdf = (text: string): UJoint[] => {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    return Array.from(xml.getElementsByTagName('joint')).filter(j => j.parentElement?.localName === 'robot').map(j => {
      const o = j.getElementsByTagName('origin')[0];
      const xyz = (o?.getAttribute('xyz') ?? '0 0 0').trim().split(/\s+/).map(Number);
      const rpy = (o?.getAttribute('rpy') ?? '0 0 0').trim().split(/\s+/).map(Number);
      // URDF: roll, pitch, yaw about the fixed axes x, y, z.
      const origin = new THREE.Matrix4().makeTranslation(xyz[0], xyz[1], xyz[2])
        .multiply(new THREE.Matrix4().makeRotationZ(rpy[2])).multiply(new THREE.Matrix4().makeRotationY(rpy[1])).multiply(new THREE.Matrix4().makeRotationX(rpy[0]));
      const lim = j.getElementsByTagName('limit')[0];
      return {
        name: j.getAttribute('name')!, type: j.getAttribute('type')!,
        parent: j.getElementsByTagName('parent')[0].getAttribute('link')!, child: j.getElementsByTagName('child')[0].getAttribute('link')!,
        origin, axis: new THREE.Vector3(...((j.getElementsByTagName('axis')[0]?.getAttribute('xyz') ?? '1 0 0').trim().split(/\s+/).map(Number) as [number, number, number])).normalize(),
        lo: Number(lim?.getAttribute('lower') ?? -1.5), hi: Number(lim?.getAttribute('upper') ?? 1.5),
      };
    });
  };
  const forward = (joints: UJoint[], q: Map<string, number>) => {
    const frames = new Map<string, THREE.Matrix4>();
    for (const j of joints) if (!joints.some(k => k.child === j.parent)) frames.set(j.parent, new THREE.Matrix4());
    for (let changed = true; changed;) {
      changed = false;
      for (const j of joints) {
        if (frames.has(j.child) || !frames.has(j.parent)) continue;
        const v = q.get(j.name) ?? 0;
        const move = j.type === 'prismatic' ? new THREE.Matrix4().makeTranslation(j.axis.x * v, j.axis.y * v, j.axis.z * v)
          : j.type === 'revolute' || j.type === 'continuous' ? new THREE.Matrix4().makeRotationAxis(j.axis, v) : new THREE.Matrix4();
        frames.set(j.child, frames.get(j.parent)!.clone().multiply(j.origin).multiply(move));
        changed = true;
      }
    }
    return frames;
  };

  for (const name of urdfRobots) {
    it(`${name} moves as its URDF says`, async () => {
      const urdf = readUrdf(fs.readFileSync(path.join(urdfDir, `${name}.urdf`), 'utf8'));
      const { cell, store } = await load(urdfDir, `${name}.dae`);
      expect([...store.stats.missing, ...cell.problems]).toEqual([]);
      const m = cell.mechanisms[0];
      const moving = urdf.filter(j => j.type !== 'fixed');
      const q = new Map(moving.map((j, i) => [j.name, valueFor(i, j.lo, j.hi)]));
      const root = urdf.find(j => !urdf.some(k => k.child === j.parent))!.parent;
      let base: THREE.Object3D = m.space;
      m.space.traverse(o => { if (o.name === `@${root}` || o.userData.nodeKey?.endsWith(`#${root}`)) base = o; });
      const actual = motions(m, base, () => {
        for (const j of m.joints) if (q.has(j.name)) cell.setJoint(j, j.type === 'revolute' ? THREE.MathUtils.radToDeg(q.get(j.name)!) : q.get(j.name)!);
      });
      const rest = forward(urdf, new Map()), moved = forward(urdf, q);
      let worst = 0;
      for (const j of m.joints) {
        const u = urdf.find(k => k.name === j.name)!;
        worst = Math.max(worst, apart(moved.get(u.child)!.clone().multiply(rest.get(u.child)!.clone().invert()), actual.get(j)!));
      }
      expect(worst).toBeLessThan(1e-6);
      // every movable joint of the URDF is a joint in the viewer
      expect(moving.every(u => m.joints.some(j => j.name === u.name))).toBe(true);
    }, 120000);
  }
});

void ({} as Cell);
