import * as THREE from 'three';
import { ColladaStore } from '../src/collada/store';
import { bounds, fetchFile, find, fixtureUrl, meshes, newStore, readFixture } from './helpers';

describe('ColladaStore', () => {
  it('fills a reference into another file and converts its units', async () => {
    const store = newStore();
    const doc = await store.load(fixtureUrl('xref/assembly.dae'));
    expect(store.stats.missing).toEqual([]);
    expect(store.stats.files).toBe(2);
    expect(doc.unit).toBe(1);
    expect(bounds(doc.root)).toEqual({ min: [1, 0, 0.5], max: [2, 1, 1.5] });
    expect(find(doc.root, 'part.dae#part_node')).not.toBeNull();
  });

  it('keeps the transform and id of a node that is the only instance in another node', async () => {
    const doc = await newStore().load(fixtureUrl('merge.dae'));
    const a = find(doc.root, 'merge.dae#outer_a')!, b = find(doc.root, 'merge.dae#outer_b')!;
    expect(bounds(a)).toEqual({ min: [0, 2, 0], max: [1, 3, 1] });
    expect(bounds(b)).toEqual({ min: [0, 2, 5], max: [1, 3, 6] });
    const inner: THREE.Object3D[] = [];
    doc.root.traverse(o => { if (o.userData.nodeKey === 'merge.dae#inner') inner.push(o); });
    expect(inner).toHaveLength(2);
  });

  it('keeps nodes without id', async () => {
    const doc = await newStore().load(fixtureUrl('anonymous.dae'));
    expect(meshes(doc.root)).toHaveLength(2);
    expect(bounds(doc.root)).toEqual({ min: [0, 0, 0], max: [4, 1, 1] });
  });

  it('draws strips and fans with one winding per primitive', async () => {
    const doc = await newStore().load(fixtureUrl('strips.dae'));
    const normals: number[] = [];
    for (const mesh of meshes(doc.root)) {
      const pos = mesh.geometry.attributes.position;
      const idx = mesh.geometry.index;
      const n = idx ? idx.count : pos.count;
      const v = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(i) : i);
      for (let i = 0; i < n; i += 3) {
        const [a, b, c] = [v(i), v(i + 1), v(i + 2)];
        normals.push(Math.sign(b.sub(a).cross(c.sub(a)).z));
      }
    }
    // 4 triangles from the strip (normal -z), 3 from the fan (normal +z), none from the degenerate strip
    expect(normals.sort()).toEqual([-1, -1, -1, -1, 1, 1, 1]);
  });

  it('draws both sides of every material', async () => {
    const doc = await newStore().load(fixtureUrl('merge.dae'));
    for (const mesh of meshes(doc.root)) for (const m of [mesh.material].flat()) expect(m.side).toBe(THREE.DoubleSide);
  });

  it('loads each file once', async () => {
    const store = newStore();
    await Promise.all([store.load(fixtureUrl('xref/assembly.dae')), store.load(fixtureUrl('xref/part.dae'))]);
    expect(store.stats.files).toBe(2);
  });

  it('reports a missing file instead of failing', async () => {
    const url = fixtureUrl('xref/broken.dae');
    const text = readFixture('xref/assembly.dae').replace('part.dae', 'gone.dae');
    const store = new ColladaStore({ fetchText: async u => (u === url ? text : fetchFile(u)) });
    const doc = await store.load(url);
    expect(meshes(doc.root)).toHaveLength(0);
    expect(store.stats.missing).toEqual([expect.stringContaining('gone.dae#part_node')]);
  });
});
