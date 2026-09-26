// Writes the small COLLADA and AML files in test/fixtures. Each one reproduces one thing
// three.js' COLLADA loader does not handle the way AML files need, with results that can
// be worked out by hand (see the comments and test/*.test.ts).
//
//   node scripts/make-fixtures.mjs          write the files
//   node scripts/make-fixtures.mjs --check  fail if the files on disk differ (CI)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const files = new Map();
const write = (name, text) => files.set(name, text.trim() + '\n');

// ---- COLLADA building blocks --------------------------------------------------------------

const head = (meter = 1) => `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2008/03/COLLADASchema" version="1.5.0">
  <asset><unit meter="${meter}"/><up_axis>Z_UP</up_axis></asset>`;

const material = (id, rgb) => ({
  effect: `<effect id="${id}_fx"><profile_COMMON><technique sid="t"><lambert><diffuse><color>${rgb} 1</color></diffuse></lambert></technique></profile_COMMON></effect>`,
  material: `<material id="${id}"><instance_effect url="#${id}_fx"/></material>`,
  bind: `<bind_material><technique_common><instance_material symbol="m" target="#${id}"/></technique_common></bind_material>`,
});

// Axis-aligned box from min to max as 12 triangles.
function box(id, [x0, y0, z0], [x1, y1, z1]) {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const tri = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return `<geometry id="${id}"><mesh>
      <source id="${id}_pos"><float_array id="${id}_pos_a" count="24">${p.flat().join(' ')}</float_array>
        <technique_common><accessor source="#${id}_pos_a" count="8" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
      <vertices id="${id}_v"><input semantic="POSITION" source="#${id}_pos"/></vertices>
      <triangles material="m" count="12"><input semantic="VERTEX" source="#${id}_v" offset="0"/><p>${tri.join(' ')}</p></triangles>
    </mesh></geometry>`;
}

const geo = (id, mat) => `<instance_geometry url="#${id}">${mat.bind}</instance_geometry>`;

// ---- xref: a node of another file, in other units -------------------------------------------
// part.dae (mm): node part_node = translate 0 0 500 + box 0..1000.
// assembly.dae (m): node asm = translate 1 0 0 + instance of part.dae#part_node.
// Expected in assembly units (m): box x 1..2, y 0..1, z 0.5..1.5.
{
  const m = material('grey', '0.6 0.6 0.6');
  write('xref/part.dae', `${head(0.001)}
  <library_effects>${m.effect}</library_effects>
  <library_materials>${m.material}</library_materials>
  <library_geometries>${box('cube', [0, 0, 0], [1000, 1000, 1000])}</library_geometries>
  <library_nodes>
    <node id="part_node" name="part"><translate>0 0 500</translate>${geo('cube', m)}</node>
  </library_nodes>
  <library_visual_scenes><visual_scene id="part_scene"><node id="part_vs"><instance_node url="#part_node"/></node></visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#part_scene"/></scene>
</COLLADA>`);
  write('xref/assembly.dae', `${head(1)}
  <library_visual_scenes><visual_scene id="asm_scene">
    <node id="asm" name="asm"><translate>1 0 0</translate><instance_node url="part.dae#part_node"/></node>
  </visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#asm_scene"/></scene>
</COLLADA>`);
}

// ---- merge: a node that holds exactly one instance ------------------------------------------
// inner = translate 0 2 0 + box 0..1. outer_a holds only an instance of inner; outer_b
// adds translate 0 0 5. three.js merges outer and inner and keeps only outer's transform.
// Expected: copy under outer_a at y 2..3, z 0..1; copy under outer_b at y 2..3, z 5..6.
{
  const m = material('blue', '0.2 0.3 0.8');
  write('merge.dae', `${head(1)}
  <library_effects>${m.effect}</library_effects>
  <library_materials>${m.material}</library_materials>
  <library_geometries>${box('cube', [0, 0, 0], [1, 1, 1])}</library_geometries>
  <library_nodes><node id="inner" name="inner"><translate>0 2 0</translate>${geo('cube', m)}</node></library_nodes>
  <library_visual_scenes><visual_scene id="s">
    <node id="outer_a" name="outer_a"><instance_node url="#inner"/></node>
    <node id="outer_b" name="outer_b"><translate>0 0 5</translate><instance_node url="#inner"/></node>
  </visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#s"/></scene>
</COLLADA>`);
}

// ---- anonymous: nodes without id ------------------------------------------------------------
// Two nodes without id, boxes at x 0..1 and x 3..4. three.js keeps only one of them.
{
  const m = material('green', '0.2 0.7 0.3');
  write('anonymous.dae', `${head(1)}
  <library_effects>${m.effect}</library_effects>
  <library_materials>${m.material}</library_materials>
  <library_geometries>${box('cube', [0, 0, 0], [1, 1, 1])}</library_geometries>
  <library_visual_scenes><visual_scene id="s">
    <node>${geo('cube', m)}</node>
    <node><translate>3 0 0</translate>${geo('cube', m)}</node>
  </visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#s"/></scene>
</COLLADA>`);
}

// ---- strips: <tristrips> and <trifans> ------------------------------------------------------
// Points in the plane z = 0. Strip v0..v5 = (0,0) (0,1) (1,0) (1,1) (2,0) (2,1): 4
// triangles, all with normal -z. A second strip v0 v1 v1 v2 has only degenerate triangles.
// Fan c a b d e = (5,.5) (4,0) (6,0) (6,1) (4,1): 3 triangles, all with normal +z.
// Inputs: VERTEX at offset 0, NORMAL at offset 1, so each vertex is two indices.
{
  const m = material('orange', '0.9 0.5 0.1');
  const pts = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1], [5, 0.5], [4, 0], [6, 0], [6, 1], [4, 1]];
  const v = (...ix) => ix.map(i => `${i} 0`).join(' ');
  write('strips.dae', `${head(1)}
  <library_effects>${m.effect}</library_effects>
  <library_materials>${m.material}</library_materials>
  <library_geometries><geometry id="flat"><mesh>
    <source id="flat_pos"><float_array id="flat_pos_a" count="${pts.length * 3}">${pts.map(([x, y]) => `${x} ${y} 0`).join(' ')}</float_array>
      <technique_common><accessor source="#flat_pos_a" count="${pts.length}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
    <source id="flat_nrm"><float_array id="flat_nrm_a" count="3">0 0 1</float_array>
      <technique_common><accessor source="#flat_nrm_a" count="1" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
    <vertices id="flat_v"><input semantic="POSITION" source="#flat_pos"/></vertices>
    <tristrips material="m" count="2">
      <input semantic="VERTEX" source="#flat_v" offset="0"/><input semantic="NORMAL" source="#flat_nrm" offset="1"/>
      <p>${v(0, 1, 2, 3, 4, 5)}</p>
      <p>${v(0, 1, 1, 2)}</p>
    </tristrips>
    <trifans material="m" count="1">
      <input semantic="VERTEX" source="#flat_v" offset="0"/><input semantic="NORMAL" source="#flat_nrm" offset="1"/>
      <p>${v(6, 7, 8, 9, 10)}</p>
    </trifans>
  </mesh></geometry></library_geometries>
  <library_visual_scenes><visual_scene id="s"><node id="flat_node">${geo('flat', m)}</node></visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#s"/></scene>
</COLLADA>`);
}

// ---- polygons: one <p> per polygon -----------------------------------------------------------
// A quad (0,0) (1,0) (1,1) (0,1) and a triangle (2,0) (3,0) (2,1). three.js keeps only the
// last <p>; all three triangles must be there, covering x 0..3.
{
  const m = material('red', '0.8 0.2 0.2');
  const pts = [[0, 0], [1, 0], [1, 1], [0, 1], [2, 0], [3, 0], [2, 1]];
  write('polygons.dae', `${head(1)}
  <library_effects>${m.effect}</library_effects>
  <library_materials>${m.material}</library_materials>
  <library_geometries><geometry id="poly"><mesh>
    <source id="poly_pos"><float_array id="poly_pos_a" count="${pts.length * 3}">${pts.map(([x, y]) => `${x} ${y} 0`).join(' ')}</float_array>
      <technique_common><accessor source="#poly_pos_a" count="${pts.length}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
    <vertices id="poly_v"><input semantic="POSITION" source="#poly_pos"/></vertices>
    <polygons material="m" count="2"><input semantic="VERTEX" source="#poly_v" offset="0"/><p>0 1 2 3</p><p>4 5 6</p></polygons>
  </mesh></geometry></library_geometries>
  <library_visual_scenes><visual_scene id="s"><node id="poly_node">${geo('poly', m)}</node></visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#s"/></scene>
</COLLADA>`);
}

// ---- arm: two links in the plane z = 0, lengths 1 m, stored at j1 = 90°, j2 = -90° ----------
// Stored pose: link 1 points along +y, link 2 starts at (0,1,0) and points along +x,
// tool0 sits at the tip of link 2: (1,1,0).
//   j1 = 0   (j2 = -90): link 2 origin (1,0,0), tool0 (1,-1,0)
//   j2 = 0   (j1 =  90): tool0 (0,2,0)
//   j1 = 0, j2 = 0     : tool0 (2,0,0)
// arm_flat.dae keeps the links as flat siblings with the stored pose baked in and the joint
// elements at 0 (like the KUKA files of the AML robot cell); arm_nested.dae nests them and
// writes the stored values into the joint elements. Both must move the same way.
// j1 is bound through an articulated system (<bind symbol><param ref>), j2 through a
// <newparam> with <SIDREF> in the kinematics scene. j2's joint writes id="axis" instead of
// sid="axis", as some exporters do.
function arm(kind) {
  const m = material('arm', '0.9 0.4 0.1');
  const links = `${box('link', [0, -0.05, -0.05], [1, 0.05, 0.05])}${box('base', [-0.2, -0.2, -0.2], [0.2, 0.2, 0])}`;
  const tool = `<node sid="tool0" name="tool0"><translate>1 0 0</translate></node>`;
  const visual = kind === 'flat' ? `
    <node id="arm" name="arm">
      <node id="base" name="base">${geo('base', m)}</node>
      <node id="link1" name="link1"><rotate>0 0 1 90</rotate><rotate sid="j1_axis">0 0 1 0</rotate>${geo('link', m)}</node>
      <node id="link2" name="link2"><translate>0 1 0</translate><rotate>0 0 1 0</rotate><rotate sid="j2_axis">0 0 1 0</rotate>${geo('link', m)}${tool}</node>
    </node>` : `
    <node id="arm" name="arm">
      <node id="base" name="base">${geo('base', m)}</node>
      <node id="link1" name="link1"><rotate sid="j1_axis">0 0 1 90</rotate>${geo('link', m)}
        <node id="link2" name="link2"><translate>1 0 0</translate><rotate sid="j2_axis">0 0 1 -90</rotate>${geo('link', m)}${tool}</node>
      </node>
    </node>`;
  return `${head(1)}
  <library_effects>${m.effect}</library_effects>
  <library_materials>${m.material}</library_materials>
  <library_geometries>${links}</library_geometries>
  <library_visual_scenes><visual_scene id="arm_scene">${visual}
  </visual_scene></library_visual_scenes>
  <library_joints>
    <joint id="arm_j1" name="j1"><revolute sid="axis"><axis>0 0 1</axis><limits><min>-180</min><max>180</max></limits></revolute></joint>
    <joint id="arm_j2" name="j2"><revolute id="axis"><axis>0 0 1</axis><limits><min>-135</min><max>135</max></limits></revolute></joint>
  </library_joints>
  <library_kinematics_models>
    <kinematics_model id="arm_model"><technique_common>
      <instance_joint sid="j1" url="#arm_j1"/>
      <instance_joint sid="j2" url="#arm_j2"/>
      <link sid="base_link">
        <attachment_full joint="arm_model/j1"><rotate>0 0 1 90</rotate>
          <link sid="l1">
            <attachment_full joint="arm_model/j2"><translate>1 0 0</translate><rotate>0 0 1 -90</rotate>
              <link sid="l2"/>
            </attachment_full>
          </link>
        </attachment_full>
      </link>
    </technique_common></kinematics_model>
  </library_kinematics_models>
  <library_articulated_systems>
    <articulated_system id="arm_system"><kinematics>
      <instance_kinematics_model sid="inst_arm_model" url="#arm_model">
        <newparam sid="sys_j1_axis"><SIDREF>arm_system/inst_arm_model/j1/axis</SIDREF></newparam>
        <newparam sid="sys_j1_value"><float>90</float></newparam>
      </instance_kinematics_model>
      <technique_common/>
    </kinematics></articulated_system>
  </library_articulated_systems>
  <library_kinematics_scenes>
    <kinematics_scene id="arm_kin_scene">
      <instance_articulated_system sid="inst_arm_system" url="#arm_system">
        <bind symbol="scene_j1_axis"><param ref="sys_j1_axis"/></bind>
        <bind symbol="scene_j1_value"><param ref="sys_j1_value"/></bind>
      </instance_articulated_system>
      <instance_kinematics_model sid="inst_arm_model" url="#arm_model">
        <newparam sid="scene_j2_axis"><SIDREF>arm_kin_scene/inst_arm_model/j2/axis</SIDREF></newparam>
        <newparam sid="scene_j2_value"><float>-90</float></newparam>
      </instance_kinematics_model>
    </kinematics_scene>
  </library_kinematics_scenes>
  <scene>
    <instance_visual_scene url="#arm_scene"/>
    <instance_kinematics_scene url="#arm_kin_scene">
      <bind_kinematics_model node="base"><param>scene_model</param></bind_kinematics_model>
      <bind_joint_axis target="link1/j1_axis"><axis><param>scene_j1_axis</param></axis><value><param>scene_j1_value</param></value></bind_joint_axis>
      <bind_joint_axis target="link2/j2_axis"><axis><param>scene_j2_axis</param></axis><value><param>scene_j2_value</param></value></bind_joint_axis>
    </instance_kinematics_scene>
  </scene>
</COLLADA>`;
}
write('arm_flat.dae', arm('flat'));
write('arm_nested.dae', arm('nested'));

// ---- The same arm as two other writers put it --------------------------------------------
// Both draw the kinematics model at 0: link 1 along +y, link 2 along +x from (0,1,0),
// tool0 at (1,1,0).
//
// arm_openrave.dae, as the OpenRAVE writer: links in <library_nodes>, pulled into the scene by
// <instance_node>; joints inside the kinematics model (<joint sid>); parameters passed through
// a motion and a kinematics <articulated_system>; targets in a node below the one named
// ("visual1/node_joint0_axis0"). It stores j1 = -90, j2 = 90, angles from the model's 0 that
// are applied at load: link 1 along +x, link 2 along +x from (1,0,0), tool0 at (2,0,0).
//
// arm_urdf.dae, as collada_urdf (ROS): nodes nested in the visual scene; parameters passed
// with a path in <bind><param ref="system/param">; targets that start with a node's sid and
// skip levels ("node0/node2/node_j2_axis0"). It stores 0 for both joints.
function writerArm(kind) {
  const m = material('arm', '0.9 0.4 0.1');
  const links = `${box('link', [0, -0.05, -0.05], [1, 0.05, 0.05])}${box('base', [-0.2, -0.2, -0.2], [0.2, 0.2, 0])}`;
  const tool = `<node sid="tool0" name="tool0"><translate>1 0 0</translate></node>`;
  const ids = kind === 'openrave'
    ? { tool: 'OpenRAVE Collada Writer v0.3.5', model: 'kmodel1', j: ['joint0', 'joint1'], node: n => `v1.node${n}`, axis: j => `node_${j}_axis0` }
    : { tool: 'URDF Collada Writer', model: 'kmodel0', j: ['j1', 'j2'], node: n => `vkmodel0_node${n}`, axis: j => `node_${j}_axis0` };
  const [a, b] = ids.j;
  const chain = `
      <node id="${ids.node(0)}" sid="node0" name="base">${geo('base', m)}
        <node id="${ids.node(1)}" sid="node1" name="link1"><rotate>0 0 1 90</rotate><rotate sid="${ids.axis(a)}">0 0 1 0</rotate>${geo('link', m)}
          <node id="${ids.node(2)}" sid="node2" name="link2"><translate>1 0 0</translate><rotate>0 0 1 -90</rotate><rotate sid="${ids.axis(b)}">0 0 1 0</rotate>${geo('link', m)}${tool}</node>
        </node>
      </node>`;
  const scene = kind === 'openrave'
    ? `<library_nodes>${chain}
  </library_nodes>
  <library_visual_scenes><visual_scene id="vscene"><node id="visual1" sid="visual1"><translate>0 0 0</translate><instance_node url="#${ids.node(0)}" sid="node0"/></node></visual_scene></library_visual_scenes>`
    : `<library_visual_scenes><visual_scene id="vscene"><node id="visual0" sid="visual0">${chain}
  </node></visual_scene></library_visual_scenes>`;
  const model = `<library_kinematics_models>
    <kinematics_model id="${ids.model}"><technique_common>
      <joint name="j1" sid="${a}"><revolute sid="axis0"><axis>0 0 1</axis><limits><min>-180</min><max>180</max></limits></revolute></joint>
      <joint name="j2" sid="${b}"><revolute sid="axis0"><axis>0 0 1</axis><limits><min>-135</min><max>135</max></limits></revolute></joint>
      <link sid="link0" name="base">
        <attachment_full joint="${ids.model}/${a}"><rotate>0 0 1 90</rotate>
          <link sid="link1" name="link1">
            <attachment_full joint="${ids.model}/${b}"><translate>1 0 0</translate><rotate>0 0 1 -90</rotate><link sid="link2" name="link2"/></attachment_full>
          </link>
        </attachment_full>
      </link>
    </technique_common></kinematics_model>
  </library_kinematics_models>`;
  const K = kind === 'openrave' ? 'body1_kinematics' : 'robot0_kinematics';
  const M = kind === 'openrave' ? 'body1_motion' : 'robot0_motion';
  const sep = kind === 'openrave' ? '.' : '_';
  const kParam = j => `${K}_${ids.model}_inst_${j}${sep}axis0`;
  const mParam = j => `${M}_${kParam(j)}`;
  const systems = `<library_articulated_systems>
    <articulated_system id="${K}"><kinematics>
      <instance_kinematics_model url="#${ids.model}" sid="${ids.model}_inst">
        ${ids.j.map(j => `<newparam sid="${kParam(j)}"><SIDREF>${K}/${ids.model}_inst/${j}/axis0</SIDREF></newparam>`).join('\n        ')}
      </instance_kinematics_model><technique_common/>
    </kinematics></articulated_system>
    <articulated_system id="${M}"><motion>
      <instance_articulated_system url="#${K}">
        ${ids.j.map(j => `<newparam sid="${mParam(j)}"><SIDREF>${K}/${kParam(j)}</SIDREF></newparam>`).join('\n        ')}
      </instance_articulated_system><technique_common/>
    </motion></articulated_system>
  </library_articulated_systems>`;
  const values = kind === 'openrave' ? [-90, 90] : [0, 0];
  const kscene = kind === 'openrave'
    ? ids.j.map((j, i) => `<newparam sid="kscene_${j}_axis"><SIDREF>${M}/${mParam(j)}</SIDREF></newparam>
        <newparam sid="kscene_${j}_value"><float>${values[i]}</float></newparam>`).join('\n        ')
    : ids.j.map((j, i) => `<bind symbol="kscene_${j}_axis"><param ref="${M}/${mParam(j)}"/></bind>
        <bind symbol="kscene_${j}_value"><param ref="${M}/${M}_value_${j}"/></bind>`).join('\n        ');
  // collada_urdf passes the values through the motion system as well.
  const urdfValues = kind === 'openrave' ? '' : ids.j.map((j, i) => `<newparam sid="${M}_value_${j}"><float>${values[i]}</float></newparam>`).join('');
  const targets = kind === 'openrave'
    ? [`visual1/${ids.axis(a)}`, `visual1/${ids.axis(b)}`]
    : [`node1/${ids.axis(a)}`, `node0/node2/${ids.axis(b)}`];
  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2008/03/COLLADASchema" version="1.5.0">
  <asset><contributor><authoring_tool>${ids.tool}</authoring_tool></contributor><unit/><up_axis>Z_UP</up_axis></asset>
  <library_effects>${m.effect}</library_effects>
  <library_materials>${m.material}</library_materials>
  <library_geometries>${links}</library_geometries>
  ${scene}
  ${model}
  ${systems.replace('<technique_common/>\n    </motion>', `<technique_common/>${urdfValues}\n    </motion>`)}
  <library_kinematics_scenes>
    <kinematics_scene id="kscene">
      <instance_articulated_system sid="${M}_inst" url="#${M}">
        ${kscene}
      </instance_articulated_system>
    </kinematics_scene>
  </library_kinematics_scenes>
  <scene>
    <instance_visual_scene url="#vscene"/>
    <instance_kinematics_scene url="#kscene">
      <bind_kinematics_model node="${kind === 'openrave' ? 'visual1' : 'visual0'}/node0"><param>kscene_model</param></bind_kinematics_model>
      ${ids.j.map((j, i) => `<bind_joint_axis target="${targets[i]}"><axis><param>kscene_${j}_axis</param></axis><value><param>kscene_${j}_value</param></value></bind_joint_axis>`).join('\n      ')}
    </instance_kinematics_scene>
  </scene>
</COLLADA>`;
}
write('arm_openrave.dae', writerArm('openrave'));
write('arm_urdf.dae', writerArm('urdf'));

{
  const m = material('grip', '0.3 0.3 0.3');
  write('gripper.dae', `${head(1)}
  <library_effects>${m.effect}</library_effects>
  <library_materials>${m.material}</library_materials>
  <library_geometries>${box('grip', [0, -0.1, -0.1], [0.3, 0.1, 0.1])}</library_geometries>
  <library_visual_scenes><visual_scene id="s"><node id="gripper">${geo('grip', m)}</node></visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#s"/></scene>
</COLLADA>`);
}

// ---- cell.aml: CAEX 3.0 --------------------------------------------------------------------
// FlatArm at x = 5 turned by rz = 90: tool0 at (5,0,0) + Rz90 (1,1,0) = (4,1,0), facing +y.
// Gripper placed there by its Frame and linked to the arm's tool0 through attachment
// interfaces; it must follow the arm. NestedArm at y = -5: tool0 at (1,-4,0).
// Link2 elements are implicit references to link2 with the stored pose as Frame.
// Link2_Marker is a plain AML frame at the tip of link 2 (x = 1 in link 2), without COLLADA:
// it must stay on tool0 when the arm moves. Tilted turns by rx = 90, ry = 90, where the
// order of the rotations matters: its y axis must point along +x.
{
  const ICL = 'AutomationMLInterfaceClassLib/AutomationMLBaseInterface';
  const attr = (name, v) => `<Attribute Name="${name}" AttributeDataType="xs:double"><Value>${v}</Value></Attribute>`;
  const frame = f => `<Attribute Name="Frame">${['x', 'y', 'z', 'rx', 'ry', 'rz'].map(k => attr(k, f[k] ?? 0)).join('')}</Attribute>`;
  const collada = (id, uri, refType, target) => `<ExternalInterface Name="Representation" ID="${id}" RefBaseClassPath="${ICL}/ExternalDataConnector/COLLADAInterface">
          <Attribute Name="refURI" AttributeDataType="xs:anyURI"><Value>${uri}</Value></Attribute>
          <Attribute Name="refType" AttributeDataType="xs:string"><Value>${refType}</Value></Attribute>${target ? `
          <Attribute Name="target" AttributeDataType="xs:string"><Value>${target}</Value></Attribute>` : ''}
        </ExternalInterface>`;
  const attachment = (id, name) => `<ExternalInterface Name="${name}" ID="${id}" RefBaseClassPath="${ICL}/AttachmentInterface"/>`;
  write('cell.aml', `<?xml version="1.0" encoding="utf-8"?>
<CAEXFile SchemaVersion="3.0" FileName="cell.aml" xmlns="http://www.dke.de/CAEX">
  <SuperiorStandardVersion>AutomationML 2.10</SuperiorStandardVersion>
  <InstanceHierarchy Name="Cell" ID="ih-1">
    <Version>1.0</Version>
    <InternalElement Name="Cell" ID="cell">
      <InternalElement Name="FlatArm" ID="flat-arm">
        ${frame({ x: 5, rz: 90 })}
        ${collada('flat-arm-geo', 'arm_flat.dae', 'explicit')}
        <InternalElement Name="Link2" ID="flat-link2">
          ${frame({ y: 1 })}
          ${collada('flat-link2-ref', 'arm_flat.dae#link2', 'implicit')}
          <InternalElement Name="Link2_Tool" ID="flat-tool">
            ${collada('flat-tool-ref', 'arm_flat.dae#link2', 'implicit', './tool0')}
            ${attachment('flat-tool-att', 'ToGripper')}
          </InternalElement>
          <InternalElement Name="Link2_Marker" ID="flat-marker">
            ${frame({ x: 1 })}
          </InternalElement>
        </InternalElement>
      </InternalElement>
      <InternalElement Name="Gripper" ID="gripper">
        ${frame({ x: 4, y: 1, rz: 90 })}
        ${collada('gripper-geo', 'gripper.dae', 'explicit')}
        <InternalElement Name="Gripper_Mount" ID="gripper-mount">
          ${frame({})}
          ${attachment('gripper-att', 'ToArm')}
        </InternalElement>
      </InternalElement>
      <InternalElement Name="NestedArm" ID="nested-arm">
        ${frame({ y: -5 })}
        ${collada('nested-arm-geo', 'arm_nested.dae', 'explicit')}
        <InternalElement Name="Link2" ID="nested-link2">
          ${frame({ y: 1 })}
          ${collada('nested-link2-ref', 'arm_nested.dae#link2', 'implicit')}
        </InternalElement>
      </InternalElement>
      <InternalElement Name="Tilted" ID="tilted">
        ${frame({ z: 3, rx: 90, ry: 90 })}
        ${collada('tilted-geo', 'gripper.dae', 'explicit')}
      </InternalElement>
      <InternalLink Name="GripperOnArm" RefPartnerSideA="flat-tool-att" RefPartnerSideB="gripper-att"/>
    </InternalElement>
  </InstanceHierarchy>
</CAEXFile>`);
}

// ---- write or check ------------------------------------------------------------------------
const check = process.argv.includes('--check');
let differ = 0;
for (const [name, text] of files) {
  const file = path.join(out, name);
  if (check) {
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (now !== text) { console.error(`differs from the script: test/fixtures/${name}`); differ++; }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}
if (check && differ) process.exit(1);
console.log(check ? `${files.size} fixtures match the script` : `wrote ${files.size} fixtures to test/fixtures`);
