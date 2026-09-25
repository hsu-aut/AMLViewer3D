// Checks against the AutomationML e.V. example "Robot cell". The data is not part of the
// repository (by-nc-sa). Unpack it to data/robotcell (or set ROBOTCELL to its folder) and
// run npm run test:robotcell (a few minutes).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { parseAml } from '../src/aml/reader';
import { buildCell, type Cell } from '../src/scene/cell';
import { frameMatrix } from '../src/scene/frame';
import { ColladaStore } from '../src/collada/store';
import { inThread } from '../src/collada/offload';
import { fetchFile, newStore } from './helpers';

const dir = path.resolve(process.env.ROBOTCELL || 'data/robotcell');
const available = fs.existsSync(path.join(dir, 'AmlDocument.aml'));

const decompose = (m: THREE.Matrix4) => { const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); m.decompose(p, q, s); return { p, q }; };
const offBy = (a: THREE.Matrix4, b: THREE.Matrix4) => {
  const x = decompose(a), y = decompose(b);
  return { mm: x.p.distanceTo(y.p) * 1000, deg: THREE.MathUtils.radToDeg(x.q.angleTo(y.q)) };
};
const close = (d: { mm: number; deg: number }) => d.mm < 1 && d.deg < 0.1;

describe.skipIf(!available)('AutomationML e.V. robot cell', () => {
  let cell: Cell;
  let store: ReturnType<typeof newStore>;

  beforeAll(async () => {
    store = newStore();
    const url = pathToFileURL(path.join(dir, 'AmlDocument.aml')).href;
    cell = await buildCell(parseAml(fs.readFileSync(path.join(dir, 'AmlDocument.aml'), 'utf8')), url, store);
  }, 900_000);

  const triangles = (root: THREE.Object3D) => {
    let n = 0;
    root.traverse(o => { const g = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry : null; if (g) n += (g.index?.count ?? g.attributes.position?.count ?? 0) / 3; });
    return n;
  };

  it('loads every file and resolves every reference', () => {
    expect(triangles(cell.world)).toBe(7_576_407);
    expect(store.stats.files).toBe(406);
    expect(store.stats.missing).toEqual([]);
    expect(cell.problems).toEqual([]);
    expect(cell.mechanisms).toHaveLength(28);
    expect(cell.mechanisms.reduce((n, m) => n + m.joints.length, 0)).toBe(981);
  });

  it('puts every machine link with a Frame exactly on it', () => {
    const rows = [...cell.elements.values()].filter(e => e.mapped && e.el.frame).map(e => {
      const rel = e.group.parent!.matrixWorld.clone().invert().multiply(e.mapped!.matrixWorld);
      return { name: e.el.name, ...offBy(rel, frameMatrix(e.el.frame!)) };
    });
    expect(rows).toHaveLength(15);
    expect(rows.filter(r => !close(r))).toEqual([]);
  });

  // In 8 of 18 attachment links one side states its point neither by COLLADA target nor by
  // Frame; those are left out. The other 10 must coincide, also after moving the robots.
  const stated = (el: Cell['aml']['byId'] extends Map<string, infer E> ? E : never) =>
    !!el.frame || el.collada.some(c => c.refType === 'implicit' && !!c.target);
  const pairs = () => cell.aml.links
    .filter(l => l.sideA?.kind === 'AttachmentInterface' && l.sideB?.kind === 'AttachmentInterface')
    .filter(l => stated(l.sideA!.element) && stated(l.sideB!.element))
    .map(l => ({ name: l.name, ...offBy(cell.attachmentPoint(l.sideA!.element)!.matrixWorld, cell.attachmentPoint(l.sideB!.element)!.matrixWorld) }));

  it('keeps mounted parts on their points when the robots move', () => {
    expect(pairs()).toHaveLength(10);
    expect(pairs().filter(r => !close(r))).toEqual([]);
    const robots = cell.mechanisms.filter(m => m.joints.some(j => j.name === 'Joint_1'));
    expect(robots).toHaveLength(5);
    for (const r of robots) {
      cell.setJoint(r.joints.find(j => j.name === 'Joint_1')!, r.joints.find(j => j.name === 'Joint_1')!.initial + 30);
      cell.setJoint(r.joints.find(j => j.name === 'Joint_6')!, r.joints.find(j => j.name === 'Joint_6')!.initial + 45);
    }
    expect(pairs().filter(r => !close(r))).toEqual([]);
    cell.resetJoints();
  });

  it('carries the robot along when its linear axis moves', () => {
    const axis = cell.mechanisms.find(m => m.element.name === '010GES191')!;
    const travel = axis.joints.find(j => j.name === 'Prismatic.1')!;
    const robot = [...cell.elements.values()].find(e => e.el.name === '010RB_100_KR240R2700prime_')!;
    const before = new THREE.Vector3().setFromMatrixPosition(robot.group.matrixWorld);
    cell.setJoint(travel, travel.initial + 1000);
    const after = new THREE.Vector3().setFromMatrixPosition(robot.group.matrixWorld);
    expect(after.distanceTo(before)).toBeCloseTo(1, 6);
    cell.resetJoints();
  });

  it('gives the same cell when the work is handed to workers', async () => {
    const offloaded = new ColladaStore({ offload: inThread(fetchFile) });
    const url = pathToFileURL(path.join(dir, 'AmlDocument.aml')).href;
    const other = await buildCell(parseAml(fs.readFileSync(path.join(dir, 'AmlDocument.aml'), 'utf8')), url, offloaded);
    expect(offloaded.stats.missing).toEqual([]);
    expect(other.problems).toEqual([]);
    expect(triangles(other.world)).toBe(triangles(cell.world));
    const box = (c: Cell) => new THREE.Box3().setFromObject(c.world);
    expect(box(other).min.distanceTo(box(cell).min)).toBeLessThan(1e-9);
    expect(box(other).max.distanceTo(box(cell).max)).toBeLessThan(1e-9);
  }, 900_000);
});
