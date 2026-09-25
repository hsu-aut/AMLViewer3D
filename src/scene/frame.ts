import * as THREE from 'three';
import type { Frame } from '../aml/reader';

/**
 * Pose of an AML Frame in its parent: position in metres, then rotations rx, ry, rz
 * (degrees) about the parent's fixed x, y and z axes in this order, so R = Rz · Ry · Rx.
 *
 * The reading is measured, not assumed: with it the frames of the machine links in the
 * AutomationML e.V. robot cell sit exactly where the COLLADA kinematics puts them; with
 * rotations about moving axes (R = Rx · Ry · Rz) 10 of 15 are off by up to 171°.
 */
export function frameMatrix(f: Frame, order: 'fixed' | 'moving' = 'fixed'): THREE.Matrix4 {
  const d = THREE.MathUtils.degToRad;
  const euler = new THREE.Euler(d(f.rx), d(f.ry), d(f.rz), order === 'fixed' ? 'ZYX' : 'XYZ');
  return new THREE.Matrix4().compose(new THREE.Vector3(f.x, f.y, f.z), new THREE.Quaternion().setFromEuler(euler), new THREE.Vector3(1, 1, 1));
}
