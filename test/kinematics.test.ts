import * as THREE from 'three';
import { jointFrame, jointMotion, readKinematics } from '../src/collada/kinematics';
import { readFixture } from './helpers';

describe('readKinematics', () => {
  const flat = readKinematics(readFixture('arm_flat.dae'));

  it('resolves both parameter chains: bind/param ref and newparam/SIDREF', () => {
    expect(flat.problems).toEqual([]);
    expect(flat.joints.map(j => [j.name, j.key, j.nodeId, j.transformSid, j.initial])).toEqual([
      ['j1', 'arm_model/j1', 'link1', 'j1_axis', 90],
      ['j2', 'arm_model/j2', 'link2', 'j2_axis', -90],
    ]);
  });

  it('reads type, axis and limits, also from joints written with id="axis"', () => {
    expect(flat.joints.map(j => [j.type, j.axis, j.min, j.max])).toEqual([
      ['revolute', [0, 0, 1], -180, 180],
      ['revolute', [0, 0, 1], -135, 135],
    ]);
  });

  it('reads the chain from nested links', () => {
    expect(flat.joints.map(j => j.parent)).toEqual([null, 'arm_model/j1']);
  });

  it('reports bindings it cannot resolve', () => {
    const broken = readFixture('arm_flat.dae').replace('<SIDREF>arm_kin_scene/inst_arm_model/j2/axis</SIDREF>', '<SIDREF>nowhere</SIDREF>');
    const k = readKinematics(broken);
    expect(k.joints.map(j => j.name)).toEqual(['j1']);
    expect(k.problems).toEqual(['link2/j2_axis: joint not resolved']);
  });
});

describe('jointFrame and jointMotion', () => {
  const [j1, j2] = readKinematics(readFixture('arm_flat.dae')).joints;

  it('put the joint axis where its transform element is', () => {
    // link2: translate 0 1 0, rotate 0 0 1 0, then the joint element
    const origin = new THREE.Vector3().setFromMatrixPosition(jointFrame(j2));
    expect(origin.toArray()).toEqual([0, 1, 0]);
    expect(new THREE.Vector3().setFromMatrixPosition(jointFrame(j1)).toArray()).toEqual([0, 0, 0]);
  });

  it('rotate about the element axis by the given degrees', () => {
    const p = new THREE.Vector3(1, 0, 0).applyMatrix4(jointMotion(j1, 90));
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(1, 12);
  });
});
