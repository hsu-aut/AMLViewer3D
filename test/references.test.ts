// References between files as they occur in real AML folders: files that use nodes of each
// other, a file that names itself, cycles, and paths spelled in different ways. The files
// are written here, not in fixtures/, because each case needs only a few nodes.
import * as THREE from 'three';
import { ColladaStore, decodeName } from '../src/collada/store';
import { inThread } from '../src/collada/offload';
import { parseAml } from '../src/aml/reader';
import { buildCell, fileUrl } from '../src/scene/cell';
import { find, meshes } from './helpers';

const BASE = 'file:///fx/';

const CUBE = `
  <library_effects><effect id="fx"><profile_COMMON><technique sid="t"><lambert><diffuse><color>0.6 0.6 0.6 1</color></diffuse></lambert></technique></profile_COMMON></effect></library_effects>
  <library_materials><material id="mat"><instance_effect url="#fx"/></material></library_materials>
  <library_geometries><geometry id="cube"><mesh>
    <source id="cube_pos"><float_array id="cube_pos_a" count="9">0 0 0 1 0 0 0 1 0</float_array>
      <technique_common><accessor source="#cube_pos_a" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
    <vertices id="cube_v"><input semantic="POSITION" source="#cube_pos"/></vertices>
    <triangles material="m" count="1"><input semantic="VERTEX" source="#cube_v" offset="0"/><p>0 1 2</p></triangles>
  </mesh></geometry></library_geometries>`;
const shape = `<instance_geometry url="#cube"><bind_material><technique_common><instance_material symbol="m" target="#mat"/></technique_common></bind_material></instance_geometry>`;

/** A COLLADA file with a triangle, library nodes and a scene. */
const dae = (libraryNodes: string, sceneNodes: string, extra = CUBE) => `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2008/03/COLLADASchema" version="1.5.0">
  <asset><unit meter="1"/><up_axis>Z_UP</up_axis></asset>
  ${extra}
  <library_nodes>${libraryNodes}</library_nodes>
  <library_visual_scenes><visual_scene id="s">${sceneNodes}</visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#s"/></scene>
</COLLADA>`;

/** A store over files held in memory; the names are paths below BASE. */
function storeOf(files: Record<string, string>, offload = false) {
  const fetched: string[] = [];
  const fetchText = async (url: string) => {
    fetched.push(url);
    const name = url.slice(BASE.length);
    const text = files[decodeName(name)] ?? files[name];
    if (text === undefined) throw new Error(`404 ${url}`);
    return text;
  };
  const store = offload ? new ColladaStore({ offload: inThread(fetchText) }) : new ColladaStore({ fetchText });
  return { store, fetched };
}

/** Fails instead of waiting for the test's own timeout when loading hangs. */
const soon = <T>(p: Promise<T>, ms = 3000) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('still loading after 3 s')), ms))]);

const MUTUAL = {
  'a.dae': dae(`<node id="a2">${shape}</node>`, `<node id="a_root">${shape}<node id="a_hold"><instance_node url="b.dae#b1"/></node></node>`),
  'b.dae': dae(`<node id="b1">${shape}</node>`, `<node id="b_root">${shape}<node id="b_hold"><instance_node url="a.dae#a2"/></node></node>`),
};

const ie = (id: string, ref: string, type = 'explicit', children = '') => `
  <InternalElement Name="${id}" ID="${id}">
    <ExternalInterface Name="Rep" ID="${id}-rep" RefBaseClassPath="AutomationMLInterfaceClassLib/AutomationMLBaseInterface/ExternalDataConnector/COLLADAInterface">
      <Attribute Name="refURI"><Value>${ref}</Value></Attribute>
      <Attribute Name="refType"><Value>${type}</Value></Attribute>
    </ExternalInterface>${children}
  </InternalElement>`;
const aml = (body: string) =>
  `<?xml version="1.0"?><CAEXFile SchemaVersion="3.0" xmlns="http://www.dke.de/CAEX"><InstanceHierarchy Name="IH" ID="ih">${body}</InstanceHierarchy></CAEXFile>`;

describe('references between files', () => {
  it('loads two files that use nodes of each other, both at once', async () => {
    const { store } = storeOf(MUTUAL);
    const [a, b] = await soon(Promise.all([store.load(BASE + 'a.dae'), store.load(BASE + 'b.dae')]));
    expect(store.stats.missing).toEqual([]);
    expect(find(a.root, 'b.dae#b1')).not.toBeNull();
    expect(find(b.root, 'a.dae#a2')).not.toBeNull();
  });

  it('does not take two files that use each other for a cycle', async () => {
    const { store } = storeOf(MUTUAL);
    const a = await soon(store.load(BASE + 'a.dae'));
    expect(store.stats.missing).toEqual([]);
    expect(meshes(a.root)).toHaveLength(2);
  });

  it('loads them as sibling elements of a cell, with workers', async () => {
    const { store } = storeOf(MUTUAL, true);
    const cell = await soon(buildCell(parseAml(aml(ie('A', 'a.dae') + ie('B', 'b.dae'))), BASE + 'cell.aml', store));
    expect([...cell.problems, ...store.stats.missing]).toEqual([]);
    expect(meshes(cell.elements.get('A')!.instance!)).toHaveLength(2);
    expect(meshes(cell.elements.get('B')!.instance!)).toHaveLength(2);
  });

  it('reads a reference to a node of the same file by the file name', async () => {
    const { store, fetched } = storeOf({ 'self.dae': dae(`<node id="s1">${shape}</node>`, `<node id="t"><instance_node url="self.dae#s1"/></node>`) });
    const doc = await soon(store.load(BASE + 'self.dae'));
    expect(store.stats.missing).toEqual([]);
    expect(find(doc.root, 'self.dae#s1')).not.toBeNull();
    expect(fetched).toHaveLength(1);
  });

  it('reports a node that contains itself and finishes', async () => {
    const { store } = storeOf({
      'loop.dae': dae(`<node id="c1">${shape}<instance_node url="#c2"/></node><node id="c2"><instance_node url="#c1"/></node>`, `<node id="t"><instance_node url="#c1"/></node>`),
    });
    await soon(store.load(BASE + 'loop.dae'));
    expect(store.stats.missing.join('\n')).toMatch(/reference cycle/);
  });

  it('reports a cycle through two files and finishes', async () => {
    const { store } = storeOf({
      'x.dae': dae(`<node id="x1">${shape}<instance_node url="y.dae#y1"/></node>`, `<node id="t"><instance_node url="#x1"/></node>`),
      'y.dae': dae(`<node id="y1">${shape}<instance_node url="x.dae#x1"/></node>`, `<node id="t"><instance_node url="#y1"/></node>`),
    });
    await soon(Promise.all([store.load(BASE + 'x.dae'), store.load(BASE + 'y.dae')]));
    expect(store.stats.missing.join('\n')).toMatch(/reference cycle/);
  });

  it('reports a missing node once, however often it is used', async () => {
    const { store } = storeOf({ 'm.dae': dae('', `<node id="t1"><instance_node url="gone.dae#g"/></node><node id="t2"><instance_node url="gone.dae#g"/></node>`) });
    await soon(store.load(BASE + 'm.dae'));
    expect(store.stats.missing).toHaveLength(1);
  });

  it('loads a file with a TGA texture', async () => {
    const texture = `
      <library_images><image id="img"><init_from>wood.tga</init_from></image></library_images>
      <library_effects><effect id="fx"><profile_COMMON><newparam sid="surf"><surface type="2D"><init_from>img</init_from></surface></newparam><newparam sid="samp"><sampler2D><source>surf</source></sampler2D></newparam><technique sid="t"><lambert><diffuse><texture texture="samp" texcoord="UV"/></diffuse></lambert></technique></profile_COMMON></effect></library_effects>`;
    const { store } = storeOf({ 'tex.dae': dae('', `<node id="n">${shape}</node>`, CUBE.replace(/<library_effects>[\s\S]*?<\/library_effects>/, texture)) });
    const doc = await soon(store.load(BASE + 'tex.dae'));
    const mesh = meshes(doc.root)[0];
    expect((mesh.material as THREE.MeshLambertMaterial).map).toBeInstanceOf(THREE.Texture);
  });

  it('reads a file with a bare % in its name', async () => {
    const { store } = storeOf({ 'Col/100%.dae': dae('', `<node id="n">${shape}</node>`) });
    const cell = await soon(buildCell(parseAml(aml(ie('P', 'Col/100%.dae'))), BASE + 'cell.aml', store));
    expect([...cell.problems, ...store.stats.missing]).toEqual([]);
    expect(cell.elements.get('P')!.instance).not.toBeNull();
  });
});

describe('spellings of a reference', () => {
  const robot = { 'Col/robot.dae': dae('', `<node id="r">${shape}<node id="a_hold">${shape}</node></node>`) };

  it.each([
    ['backslashes', 'Col\\robot.dae', 'Col\\robot.dae#a_hold'],
    ['another case', 'Col/robot.dae', 'Col/Robot.dae#a_hold'],
    ['an escape', 'Col/robot.dae', 'Col/rob%6Ft.dae#a_hold'],
  ])('finds an implicit node written with %s', async (_what, explicit, implicit) => {
    const { store } = storeOf(robot);
    const cell = await soon(buildCell(parseAml(aml(ie('R', explicit, 'explicit', ie('R2', implicit, 'implicit')))), BASE + 'cell.aml', store));
    expect(cell.problems).toEqual([]);
    expect(cell.elements.get('R2')!.mapped).not.toBeNull();
  });

  it('loads a file once however the references spell it', async () => {
    const { store, fetched } = storeOf(robot);
    await soon(buildCell(parseAml(aml(ie('R', 'Col/robot.dae') + ie('S', 'col/Robot.dae'))), BASE + 'cell.aml', store));
    expect(fetched).toHaveLength(1);
  });
});

describe('fileUrl', () => {
  const doc = 'https://aml3d-document.local/Plants/Cell%201/cell.aml';

  it('resolves a path relative to the document', () => {
    expect(fileUrl('../Col/x.dae', doc)).toBe('https://aml3d-document.local/Plants/Col/x.dae');
    expect(fileUrl('./Col/x.dae', doc, 'C:')).toBe('https://aml3d-document.local/Plants/Cell%201/Col/x.dae');
  });

  it('maps a path on the served drive onto the served root', () => {
    expect(fileUrl('file:///C:/Robots/kr 16.dae', doc, 'C:')).toBe('https://aml3d-document.local/Robots/kr%2016.dae');
    expect(fileUrl('c:\\Robots\\x.dae', doc, 'C:')).toBe('https://aml3d-document.local/Robots/x.dae');
  });

  it('refuses a path on another drive, or any drive when none is served', () => {
    expect(() => fileUrl('file:///D:/Robots/x.dae', doc, 'C:')).toThrow(/another drive/);
    expect(() => fileUrl('file:///C:/Robots/x.dae', doc)).toThrow(/absolute path/);
  });

  it('keeps the AutomationML examples\' "file:///" relative to the document', () => {
    const [el] = parseAml(aml(ie('E', 'file:///Col/x.dae'))).hierarchies[0].children;
    expect(fileUrl(el.collada[0].file, doc)).toBe('https://aml3d-document.local/Plants/Cell%201/Col/x.dae');
  });
});
