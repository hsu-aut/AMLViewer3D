import * as THREE from 'three';
import { parseAml } from '../src/aml/reader';
import { ColladaStore } from '../src/collada/store';
import { inThread, transferables } from '../src/collada/offload';
import { buildCell } from '../src/scene/cell';
import { bounds, fetchFile, fixtureUrl, meshes, readFixture, worldPosition } from './helpers';

// The worker path, run in this thread with the same copying a worker does.
const offloadStore = () => new ColladaStore({ offload: inThread(fetchFile) });

describe('loading with work offloaded', () => {
  it('resolves references into other files and converts units', async () => {
    const store = offloadStore();
    const doc = await store.load(fixtureUrl('xref/assembly.dae'));
    expect(store.stats.missing).toEqual([]);
    expect(bounds(doc.root)).toEqual({ min: [1, 0, 0.5], max: [2, 1, 1.5] });
  });

  it('builds the same geometry as the composer does in this thread', async () => {
    for (const name of ['strips.dae', 'polygons.dae', 'merge.dae', 'anonymous.dae']) {
      const here = await new ColladaStore({ fetchText: fetchFile }).load(fixtureUrl(name));
      const there = await offloadStore().load(fixtureUrl(name));
      const arrays = (root: THREE.Object3D) => meshes(root).map(m => Array.from(m.geometry.attributes.position.array));
      expect(arrays(there.root)).toEqual(arrays(here.root));
      expect(meshes(there.root).map(m => m.geometry.groups)).toEqual(meshes(here.root).map(m => m.geometry.groups));
    }
  });

  it('gives a cell that moves like the one loaded in this thread', async () => {
    const cell = await buildCell(parseAml(readFixture('cell.aml')), fixtureUrl('cell.aml'), offloadStore());
    expect(cell.problems).toEqual([]);
    const tool = () => worldPosition(cell.attachmentPoint(cell.aml.byId.get('flat-tool')!)!);
    expect(tool()).toEqual([4, 1, 0]);
    const j1 = cell.mechanisms.find(m => m.element.name === 'FlatArm')!.joints.find(j => j.name === 'j1')!;
    cell.setJoint(j1, 0);
    expect(tool()).toEqual([6, 1, 0]);
  });
});

describe('transferables', () => {
  it('collects every typed array buffer once', () => {
    const a = new Float32Array(4), b = new Int32Array(2);
    expect(transferables({ x: a, y: [b, { z: a }], n: 1, s: 'text' })).toEqual([a.buffer, b.buffer]);
  });
});
