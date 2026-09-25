import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { ColladaStore } from '../src/collada/store';

export const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixtureUrl = (name: string) => pathToFileURL(path.join(fixtures, name)).href;
export const readFixture = (name: string) => fs.readFileSync(path.join(fixtures, name), 'utf8');
export const fetchFile = async (url: string) => fs.readFileSync(fileURLToPath(url), 'utf8');
export const newStore = () => new ColladaStore({ fetchText: fetchFile });

export function bounds(object: THREE.Object3D) {
  object.updateWorldMatrix(true, true);
  const b = new THREE.Box3().setFromObject(object);
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { min: [r(b.min.x), r(b.min.y), r(b.min.z)], max: [r(b.max.x), r(b.max.y), r(b.max.z)] };
}

export function worldPosition(object: THREE.Object3D): number[] {
  object.updateWorldMatrix(true, false);
  const p = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
  return [p.x, p.y, p.z].map(v => Math.round(v * 1e6) / 1e6 + 0);
}

export function find(root: THREE.Object3D, key: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse(o => { if (!found && o.userData.nodeKey === key) found = o; });
  return found;
}

export function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const list: THREE.Mesh[] = [];
  root.traverse(o => { if ((o as THREE.Mesh).isMesh) list.push(o as THREE.Mesh); });
  return list;
}
