import * as THREE from 'three';
import { parseAml } from '../src/aml/reader';
import { frameMatrix } from '../src/scene/frame';
import { readFixture } from './helpers';

describe('parseAml', () => {
  const aml = parseAml(readFixture('cell.aml'));

  it('reads the instance hierarchy, frames and COLLADA references', () => {
    expect(aml.schemaVersion).toBe('3.0');
    const arm = aml.byId.get('flat-arm')!;
    expect(arm.frame).toEqual({ x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 90 });
    expect(arm.collada).toEqual([expect.objectContaining({ uri: 'arm_flat.dae', file: 'arm_flat.dae', fragment: null, refType: 'explicit', target: null })]);
    const tool = aml.byId.get('flat-tool')!;
    expect(tool.frame).toBeNull();
    expect(tool.collada[0]).toMatchObject({ file: 'arm_flat.dae', fragment: 'link2', refType: 'implicit', target: './tool0' });
    expect(tool.parent?.id).toBe('flat-link2');
  });

  it('resolves CAEX 3.0 links by interface ID', () => {
    expect(aml.links).toHaveLength(1);
    expect(aml.links[0].sideA).toMatchObject({ name: 'ToGripper', kind: 'AttachmentInterface' });
    expect(aml.links[0].sideB?.element.id).toBe('gripper-mount');
  });

  it('resolves CAEX 2.15 links, bracketed or not', () => {
    const doc = parseAml(`﻿<?xml version="1.0"?><CAEXFile SchemaVersion="2.15"><InstanceHierarchy Name="IH"><InternalElement ID="p" Name="P">
      <InternalElement ID="a" Name="A"><ExternalInterface ID="ia" Name="Out" RefBaseClassPath="AutomationMLBaseInterface/AttachmentInterface"/></InternalElement>
      <InternalElement ID="b" Name="B"><ExternalInterface ID="ib" Name="In" RefBaseClassPath="AttachmentInterface"/></InternalElement>
      <InternalLink Name="L1" RefPartnerSideA="[a]:[Out]" RefPartnerSideB="b:In"/>
      <InternalLink Name="L2" RefPartnerSideA="{a}:Out" RefPartnerSideB="[b]:[Missing]"/>
    </InternalElement></InstanceHierarchy></CAEXFile>`);
    expect(doc.links.map(l => [l.name, l.sideA?.element.name, l.sideB?.element.name ?? null])).toEqual([['L1', 'A', 'B'], ['L2', 'A', null]]);
  });

  it('rejects documents that are not CAEX', () => {
    expect(() => parseAml('<COLLADA/>')).toThrow('Not a CAEX document');
  });
});

describe('frameMatrix', () => {
  it('turns about the fixed axes, x first, then y, then z', () => {
    const f = { x: 0, y: 0, z: 0, rx: 90, ry: 90, rz: 0 };
    // fixed axes: Rx(90) takes +y to +z, then Ry(90) takes +z to +x
    const fixed = new THREE.Vector3(0, 1, 0).applyMatrix4(frameMatrix(f));
    expect(fixed.toArray().map(v => Math.round(v))).toEqual([1, 0, 0]);
    // moving axes would give +z instead
    const moving = new THREE.Vector3(0, 1, 0).applyMatrix4(frameMatrix(f, 'moving'));
    expect(moving.toArray().map(v => Math.round(v))).toEqual([0, 0, 1]);
  });

  it('places before it turns', () => {
    const p = new THREE.Vector3(1, 0, 0).applyMatrix4(frameMatrix({ x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 90 }));
    expect(p.toArray().map(v => Math.round(v * 1e9) / 1e9 + 0)).toEqual([5, 1, 0]);
  });
});
