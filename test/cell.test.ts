import * as THREE from 'three';
import { parseAml } from '../src/aml/reader';
import { buildCell, elementOf, type Cell, type CellJoint } from '../src/scene/cell';
import { frameMatrix } from '../src/scene/frame';
import { fixtureUrl, newStore, readFixture, worldPosition } from './helpers';

async function loadCell(): Promise<Cell> {
  return buildCell(parseAml(readFixture('cell.aml')), fixtureUrl('cell.aml'), newStore());
}

const joint = (cell: Cell, arm: string, name: string): CellJoint =>
  cell.mechanisms.find(m => m.element.name === arm)!.joints.find(j => j.name === name)!;
const tool = (cell: Cell) => worldPosition(cell.attachmentPoint(cell.aml.byId.get('flat-tool')!)!);
const mount = (cell: Cell) => worldPosition(cell.attachmentPoint(cell.aml.byId.get('gripper-mount')!)!);
// tool0 of the nested arm, found in its geometry
const nestedTool = (cell: Cell) => {
  let t: THREE.Object3D | null = null;
  cell.elements.get('nested-arm')!.instance!.traverse(o => { if (o.userData.nodeKey === 'arm_nested.dae#sid:tool0') t = o; });
  return worldPosition(t!);
};

describe('buildCell', () => {
  it('loads without problems', async () => {
    const cell = await loadCell();
    expect(cell.problems).toEqual([]);
    expect(cell.mechanisms.map(m => [m.element.name, m.joints.map(j => j.name)])).toEqual([
      ['FlatArm', ['j1', 'j2']],
      ['NestedArm', ['j1', 'j2']],
    ]);
  });

  it('puts implicit elements on their node, and the node matches the AML Frame', async () => {
    const cell = await loadCell();
    for (const id of ['flat-link2', 'nested-link2']) {
      const e = cell.elements.get(id)!;
      expect(e.mapped).not.toBeNull();
      expect(elementOf(e.mapped!.children[0] ?? e.mapped!)).toBe(id);
      const rel = e.group.parent!.matrixWorld.clone().invert().multiply(e.mapped!.matrixWorld);
      const got = new THREE.Vector3().setFromMatrixPosition(rel);
      const want = new THREE.Vector3().setFromMatrixPosition(frameMatrix(e.el.frame!));
      expect(got.distanceTo(want)).toBeLessThan(1e-9);
    }
  });

  it('shows the stored pose: tool0 of the flat arm where the gripper is mounted', async () => {
    const cell = await loadCell();
    expect(tool(cell)).toEqual([4, 1, 0]);
    expect(mount(cell)).toEqual([4, 1, 0]);
    expect(nestedTool(cell)).toEqual([1, -4, 0]);
    expect(cell.attachments.map(a => [a.leader.el.name, a.follower.el.name])).toEqual([['Link2', 'Gripper']]);
  });

  it('moves the links below a joint, for flat and nested files alike', async () => {
    const cell = await loadCell();
    cell.setJoint(joint(cell, 'FlatArm', 'j1'), 0);
    cell.setJoint(joint(cell, 'NestedArm', 'j1'), 0);
    // j1 = 0, j2 = -90: tool0 at (1,-1,0) in the arm; the flat arm is at x 5 turned by 90°
    expect(tool(cell)).toEqual([6, 1, 0]);
    expect(nestedTool(cell)).toEqual([1, -6, 0]);

    cell.setJoint(joint(cell, 'FlatArm', 'j2'), 0);
    cell.setJoint(joint(cell, 'NestedArm', 'j2'), 0);
    // straight arm: tool0 at (2,0,0) in the arm
    expect(tool(cell)).toEqual([5, 2, 0]);
    expect(nestedTool(cell)).toEqual([2, -5, 0]);
  });

  it('moves only the outer link for the outer joint', async () => {
    const cell = await loadCell();
    cell.setJoint(joint(cell, 'FlatArm', 'j2'), 0);
    cell.setJoint(joint(cell, 'NestedArm', 'j2'), 0);
    // j1 = 90, j2 = 0: tool0 at (0,2,0) in the arm
    expect(tool(cell)).toEqual([3, 0, 0]);
    expect(nestedTool(cell)).toEqual([0, -3, 0]);
  });

  it('reads Frame rotations about the fixed axes, x first', async () => {
    const cell = await loadCell();
    const group = cell.elements.get('tilted')!.group;
    const y = new THREE.Vector3(0, 1, 0).transformDirection(group.matrixWorld);
    expect(y.toArray().map(v => Math.round(v))).toEqual([1, 0, 0]);
    expect(worldPosition(group)).toEqual([0, 0, 3]);
  });

  it('carries AML frames along with the machine link they hang on', async () => {
    const cell = await loadCell();
    const marker = () => worldPosition(cell.elements.get('flat-marker')!.group);
    expect(marker()).toEqual(tool(cell));
    cell.setJoint(joint(cell, 'FlatArm', 'j1'), 0);
    cell.setJoint(joint(cell, 'FlatArm', 'j2'), 30);
    expect(marker()).toEqual(tool(cell));
  });

  it('lets the gripper follow the arm', async () => {
    const cell = await loadCell();
    for (const [name, value] of [['j1', 0], ['j2', 30], ['j1', 135]] as const) {
      cell.setJoint(joint(cell, 'FlatArm', name), value);
      expect(mount(cell)).toEqual(tool(cell));
    }
  });

  it('goes back to the stored pose', async () => {
    const cell = await loadCell();
    cell.setJoint(joint(cell, 'FlatArm', 'j1'), 10);
    cell.setJoint(joint(cell, 'FlatArm', 'j2'), 20);
    cell.resetJoints();
    expect(tool(cell)).toEqual([4, 1, 0]);
    expect(mount(cell)).toEqual([4, 1, 0]);
  });

  it('reports what it cannot resolve', async () => {
    const text = readFixture('cell.aml').replace('arm_nested.dae#link2', 'arm_nested.dae#nothing');
    const cell = await buildCell(parseAml(text), fixtureUrl('cell.aml'), newStore());
    expect(cell.problems).toEqual(['Link2: implicit node arm_nested.dae#nothing not found in any parent geometry']);
  });
});
