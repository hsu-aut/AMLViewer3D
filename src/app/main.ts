// Viewer page: instance hierarchy on the left, 3D view in the middle, details and joint
// sliders on the right. Selection works both ways between tree and view.
// The document comes from ?aml=<url>, default data/robotcell/AmlDocument.aml.
import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseAml, type AmlDocument, type AmlElement } from '../aml/reader';
import { ColladaStore } from '../collada/store';
import { WorkerPool } from '../collada/pool';
import { buildCell, elementOf, type Cell, type CellElement, type CellJoint, type Mechanism } from '../scene/cell';

const $ = (id: string) => document.getElementById(id)!;
const amlUrl = new URL(new URLSearchParams(location.search).get('aml') || 'data/robotcell/AmlDocument.aml', location.href).href;

// ---- 3D setup (Z up, metres) ------------------------------------------------------------
const canvas = $('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9ecf1);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.up.set(0, 0, 1);
camera.position.set(8, -14, 9);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(10, -15, 25);
scene.add(sun);
const grid = new THREE.GridHelper(40, 40, 0xb9bec8, 0xd3d7de);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas.parentElement!;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement!);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

function focus(object: THREE.Object3D, factor = 1.6) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, Math.max(size * factor, 0.5));
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ---- State --------------------------------------------------------------------------------
let cell: Cell | null = null;
const rows = new Map<string, { row: HTMLElement; box: HTMLElement; el: AmlElement }>();
let selected: string | null = null;
let helper: THREE.BoxHelper | null = null;

// ---- Tree ---------------------------------------------------------------------------------
function badgeFor(el: AmlElement) {
  const entry = cell!.elements.get(el.id);
  if (cell!.mechanisms.some(m => m.element === el)) return '<span class="badge kin">joints</span>';
  if (entry?.instance) return '<span class="badge geo">3D</span>';
  if (entry?.mapped) return '<span class="badge impl">part</span>';
  return '';
}

function buildTree(aml: AmlDocument) {
  const tree = $('tree');
  tree.innerHTML = '';
  const make = (el: AmlElement, parentBox: HTMLElement, depth: number) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="twist">${el.children.length ? (depth < 2 ? '▾' : '▸') : ''}</span><span class="name"></span> ${badgeFor(el)}`;
    row.querySelector('.name')!.textContent = el.name;
    row.title = el.roles.join(', ');
    parentBox.appendChild(row);
    const box = document.createElement('div');
    box.className = 'children';
    box.hidden = depth >= 2;
    parentBox.appendChild(box);
    rows.set(el.id, { row, box, el });
    row.querySelector('.twist')!.addEventListener('click', ev => { ev.stopPropagation(); toggle(el.id); });
    row.addEventListener('click', () => select(el.id, true));
    row.addEventListener('dblclick', () => { const e = cell!.elements.get(el.id); if (e) focus(e.mapped ?? e.group); });
    for (const c of el.children) make(c, box, depth + 1);
  };
  for (const ih of aml.hierarchies) for (const el of ih.children) make(el, tree, 0);
}

function toggle(id: string, open?: boolean) {
  const r = rows.get(id);
  if (!r || !r.el.children.length) return;
  r.box.hidden = open === undefined ? !r.box.hidden : !open;
  r.row.querySelector('.twist')!.textContent = r.box.hidden ? '▸' : '▾';
}

$('search').addEventListener('input', ev => {
  if (!cell) return;
  const q = (ev.target as HTMLInputElement).value.trim().toLowerCase();
  const visit = (el: AmlElement): boolean => {
    const kids = el.children.map(visit).some(Boolean);
    const hit = !q || el.name.toLowerCase().includes(q) || kids;
    rows.get(el.id)!.row.style.display = hit ? '' : 'none';
    if (q && kids) toggle(el.id, true);
    return hit;
  };
  for (const ih of cell.aml.hierarchies) ih.children.forEach(visit);
});

// ---- Selection ----------------------------------------------------------------------------
function hasGeometry(object: THREE.Object3D) { let found = false; object.traverse(o => { if ((o as THREE.Mesh).isMesh) found = true; }); return found; }

function select(id: string | null, fromTree = false) {
  if (selected) rows.get(selected)?.row.classList.remove('selected');
  selected = id;
  if (helper) { scene.remove(helper); helper.dispose(); helper = null; }
  const entry = id ? cell?.elements.get(id) : undefined;
  if (!entry) { $('details').innerHTML = '<div class="sub">Nothing selected.</div>'; return; }
  const r = rows.get(entry.el.id);
  if (r) {
    r.row.classList.add('selected');
    for (let p = r.el.parent; p; p = p.parent) toggle(p.id, true);
    if (!fromTree) r.row.scrollIntoView({ block: 'center' });
  }
  const object = entry.mapped ?? (entry.instance || hasGeometry(entry.group) ? entry.group : null);
  if (object) { helper = new THREE.BoxHelper(object, 0x2f6fdb); scene.add(helper); }
  showDetails(entry);
}

function mechanismFor(el: AmlElement): Mechanism | undefined {
  return cell!.mechanisms.find(m => m.element === el)
    ?? cell!.mechanisms.find(m => { for (let p = el.parent; p; p = p.parent) if (m.element === p) return true; return false; });
}

function showDetails(entry: CellElement) {
  const el = entry.el;
  const rowsHtml: string[] = [];
  const add = (k: string, v: unknown) => rowsHtml.push(`<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`);
  add('ID', el.id);
  if (el.roles.length) add('Role', el.roles.join(', '));
  if (el.systemUnit) add('System unit class', el.systemUnit);
  if (el.frame) add('Frame', `x ${el.frame.x}, y ${el.frame.y}, z ${el.frame.z} m; rx ${el.frame.rx}, ry ${el.frame.ry}, rz ${el.frame.rz}°`);
  for (const c of el.collada) add(`COLLADA (${c.refType})`, c.uri + (c.target ? ` → ${c.target}` : ''));
  for (const a of el.attachments) add('Attachment', a.name);
  for (const a of el.attributes.filter(a => a.name !== 'Frame')) add(a.name ?? '', a.value ?? a.children.map(c => `${c.name}=${c.value}`).join(', '));
  const details = $('details');
  details.innerHTML = `<h2>${esc(el.name)}</h2><div class="sub">${el.children.length} children</div><table>${rowsHtml.join('')}</table>`;
  const mech = mechanismFor(el);
  if (mech) details.appendChild(jointPanel(mech));
}

// ---- Joints -------------------------------------------------------------------------------
function jointPanel(mech: Mechanism) {
  const box = document.createElement('div');
  const main = mech.joints.filter(j => /^(joint|axis|achse)[ _]?\d+$/i.test(j.name));
  const primary = main.length ? main : mech.joints.slice(0, 12);
  const rest = mech.joints.filter(j => !primary.includes(j));
  box.innerHTML = `<div class="section-title" style="padding-left:0">Joints of ${esc(mech.element.name)}</div>`;
  primary.forEach(j => box.appendChild(slider(j)));
  if (rest.length) {
    const more = document.createElement('details');
    more.innerHTML = `<summary>${rest.length} further joints</summary>`;
    rest.forEach(j => more.appendChild(slider(j)));
    box.appendChild(more);
  }
  const reset = document.createElement('button');
  reset.textContent = 'Back to stored pose';
  reset.addEventListener('click', () => { cell!.resetJoints(mech); helper?.update(); if (selected) showDetails(cell!.elements.get(selected)!); });
  box.appendChild(reset);
  return box;
}

function slider(j: CellJoint) {
  const unit = j.type === 'revolute' ? '°' : ' mm';
  const span = j.type === 'revolute' ? 180 : 1000;
  const min = j.min ?? j.initial - span;
  const max = j.max ?? j.initial + span;
  const div = document.createElement('div');
  div.className = 'joint';
  div.innerHTML = `<label><span>${esc(j.name)}</span><span class="v"></span></label>
    <input type="range" min="${Math.min(min, j.value)}" max="${Math.max(max, j.value)}" step="0.1" value="${j.value}">
    <div class="limits"><span>${min}${unit}</span><span>stored ${j.initial}${unit}</span><span>${max}${unit}</span></div>`;
  const v = div.querySelector('.v')!;
  const input = div.querySelector('input')!;
  v.textContent = `${j.value.toFixed(1)}${unit}`;
  input.addEventListener('input', () => {
    cell!.setJoint(j, +input.value);
    v.textContent = `${(+input.value).toFixed(1)}${unit}`;
    helper?.update();
  });
  return div;
}

function buildMechanismList() {
  const box = $('mechs');
  for (const m of cell!.mechanisms) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="name"></span> <span class="badge kin">${m.joints.length}</span>`;
    row.querySelector('.name')!.textContent = m.element.name;
    row.addEventListener('click', () => select(m.element.id));
    row.addEventListener('dblclick', () => focus(m.entry.group));
    box.appendChild(row);
  }
}

// ---- Picking ------------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
let down: [number, number] | null = null;
canvas.addEventListener('pointerdown', ev => { down = [ev.clientX, ev.clientY]; });
function pick(ev: MouseEvent) {
  if (!cell) return null;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(cell.world, true).find(h => h.object.visible);
  return hit ? elementOf(hit.object) : null;
}
canvas.addEventListener('pointerup', ev => {
  if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 4) return;
  select(pick(ev));
});
canvas.addEventListener('dblclick', ev => {
  const id = pick(ev);
  const e = id ? cell?.elements.get(id) : undefined;
  if (e) focus(e.mapped ?? e.group);
});

// ---- Loading ------------------------------------------------------------------------------
async function start() {
  const t0 = performance.now();
  const pool = typeof Worker !== 'undefined' ? new WorkerPool() : undefined;
  const store = new ColladaStore({ offload: pool });
  const progress = setInterval(() => {
    const known = store.docs.size, done = store.stats.files;
    $('loading-text').textContent = `Loading COLLADA files: ${done} of ${known} (${(store.stats.bytes / 1e6).toFixed(0)} MB)`;
    ($('loading-bar') as HTMLElement).style.width = known ? `${((100 * done) / known).toFixed(0)}%` : '0';
  }, 150);
  try {
    const response = await fetch(amlUrl);
    if (!response.ok) throw new Error(`${response.status} ${amlUrl}`);
    const aml = parseAml(await response.text());
    $('file').textContent = `${decodeURIComponent(amlUrl.split('/').pop() ?? '')} · CAEX ${aml.schemaVersion}`;
    cell = await buildCell(aml, amlUrl, store);
    (window as unknown as { cell: Cell }).cell = cell;   // for the console and browser tests
    scene.add(cell.world);
    focus(cell.world, 0.9);
    buildTree(aml);
    buildMechanismList();
    let tris = 0;
    cell.world.traverse(o => {
      const g = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry : null;
      if (g) tris += (g.index?.count ?? g.attributes.position?.count ?? 0) / 3;
    });
    const issues = [...store.stats.missing, ...cell.problems];
    $('status').innerHTML = [
      `${aml.byId.size} elements`,
      `${store.stats.files} COLLADA files, ${(store.stats.bytes / 1e6).toFixed(0)} MB${pool ? `, ${pool.size} workers` : ''}`,
      `${Math.round(tris).toLocaleString()} triangles`,
      `${cell.mechanisms.length} mechanisms, ${cell.attachments.length} attached parts`,
      `ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
      issues.length ? `<span style="color:var(--warn)" title="${esc(issues.slice(0, 30).join('\n'))}">${issues.length} problems</span>` : 'no problems',
    ].join(' · ');
    $('loading').style.display = 'none';
  } catch (e) {
    console.error(e);
    $('loading-text').textContent = `Failed: ${(e as Error).message}`;
  } finally {
    clearInterval(progress);
    pool?.dispose();
  }
}

start();
