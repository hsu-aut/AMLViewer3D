// The two-link arm as the OpenRAVE writer and collada_urdf (ROS) write it (see
// scripts/make-fixtures.mjs). The large files these stand for are checked by
// `npm run test:robots`.
import * as THREE from 'three';
import { ColladaStore } from '../src/collada/store';
import { parseAml } from '../src/aml/reader';
import { buildCell, type Cell } from '../src/scene/cell';
import { fetchFile, find, fixtureUrl, worldPosition } from './helpers';

const aml = (file: string) => `<?xml version="1.0"?><CAEXFile SchemaVersion="3.0" FileName="w.aml" xmlns="http://www.dke.de/CAEX"><InstanceHierarchy Name="IH" ID="ih">
<InternalElement Name="Arm" ID="arm"><ExternalInterface Name="Rep" ID="rep" RefBaseClassPath="AutomationMLInterfaceClassLib/AutomationMLBaseInterface/ExternalDataConnector/COLLADAInterface">
<Attribute Name="refURI"><Value>${file}</Value></Attribute><Attribute Name="refType"><Value>explicit</Value></Attribute></ExternalInterface></InternalElement>
</InstanceHierarchy></CAEXFile>`;

async function load(file: string): Promise<Cell> {
  return buildCell(parseAml(aml(file)), fixtureUrl('w.aml'), new ColladaStore({ fetchText: fetchFile }));
}

const tool = (cell: Cell, file: string) => worldPosition(find(cell.world, `${file}#sid:tool0`)!);
const joint = (cell: Cell, name: string) => cell.mechanisms[0].joints.find(j => j.name === name)!;
const round = (v: number[]) => v.map(x => Math.round(x * 1e6) / 1e6 + 0);

describe('the OpenRAVE writer', () => {
  it('finds both joints through the articulated systems and the node library', async () => {
    const cell = await load('arm_openrave.dae');
    expect(cell.problems).toEqual([]);
    expect(cell.mechanisms[0].joints.map(j => [j.name, j.initial, j.drawn])).toEqual([['j1', -90, 0], ['j2', 90, 0]]);
  });

  it('applies the stored values, which count from the drawn pose', async () => {
    const cell = await load('arm_openrave.dae');
    expect(round(tool(cell, 'arm_openrave.dae'))).toEqual([2, 0, 0]);
    cell.setJoint(joint(cell, 'j1'), 0);
    cell.setJoint(joint(cell, 'j2'), 0);
    expect(round(tool(cell, 'arm_openrave.dae'))).toEqual([1, 1, 0]);
    cell.setJoint(joint(cell, 'j1'), -90);
    expect(round(tool(cell, 'arm_openrave.dae'))).toEqual([1, -1, 0]);
    cell.resetJoints();
    expect(round(tool(cell, 'arm_openrave.dae'))).toEqual([2, 0, 0]);
  });
});

describe('collada_urdf', () => {
  it('finds both joints through parameter paths and sid-led targets', async () => {
    const cell = await load('arm_urdf.dae');
    expect(cell.problems).toEqual([]);
    expect(cell.mechanisms[0].joints.map(j => [j.name, j.initial])).toEqual([['j1', 0], ['j2', 0]]);
  });

  it('moves the arm about its joints', async () => {
    const cell = await load('arm_urdf.dae');
    expect(round(tool(cell, 'arm_urdf.dae'))).toEqual([1, 1, 0]);
    cell.setJoint(joint(cell, 'j1'), -90);
    expect(round(tool(cell, 'arm_urdf.dae'))).toEqual([1, -1, 0]);
    cell.setJoint(joint(cell, 'j2'), 90);
    expect(round(tool(cell, 'arm_urdf.dae'))).toEqual([2, 0, 0]);
  });
});

it('keeps the drawn pose of a file that is not from OpenRAVE', async () => {
  // arm_flat.dae draws the kinematics model at 0 as well, with other stored values: the
  // robot cell's convention, where the stored values belong to the drawn pose.
  const cell = await load('arm_flat.dae');
  expect(round(tool(cell, 'arm_flat.dae'))).toEqual([1, 1, 0]);
  expect(cell.mechanisms[0].joints.every(j => j.rest === j.initial)).toBe(true);
  void THREE;
});
