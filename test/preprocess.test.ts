import { preprocess, stripsToTriangles } from '../src/collada/preprocess';
import { readFixture } from './helpers';

const triangleIndices = (xml: string) =>
  [...xml.matchAll(/<triangles\b[^>]*count="(\d+)"[^>]*>[\s\S]*?<p>([^<]*)<\/p>/g)].map(m => ({ count: +m[1], p: m[2].trim().split(/\s+/).map(Number) }));

describe('stripsToTriangles', () => {
  it('turns a strip of n vertices into n - 2 triangles with alternating order', () => {
    const out = stripsToTriangles('<tristrips material="m" count="1"><input semantic="VERTEX" offset="0"/><p>0 1 2 3 4</p></tristrips>');
    expect(triangleIndices(out)).toEqual([{ count: 3, p: [0, 1, 2, 2, 1, 3, 2, 3, 4] }]);
    expect(out).toContain('material="m"');
  });

  it('turns a fan into triangles around the first vertex', () => {
    const out = stripsToTriangles('<trifans count="1"><input semantic="VERTEX" offset="0"/><p>9 1 2 3 4</p></trifans>');
    expect(triangleIndices(out)).toEqual([{ count: 3, p: [9, 1, 2, 9, 2, 3, 9, 3, 4] }]);
  });

  it('keeps whole vertices when several inputs share an index list', () => {
    const out = stripsToTriangles('<tristrips count="1"><input semantic="VERTEX" offset="0"/><input semantic="NORMAL" offset="1"/><p>0 7 1 7 2 7 3 7</p></tristrips>');
    expect(triangleIndices(out)).toEqual([{ count: 2, p: [0, 7, 1, 7, 2, 7, 2, 7, 1, 7, 3, 7] }]);
  });

  it('drops triangles with a repeated vertex and joins all <p> into one', () => {
    const out = stripsToTriangles('<tristrips count="2"><input semantic="VERTEX" offset="0"/><p>0 1 2</p><p>0 1 1 2</p></tristrips>');
    expect(triangleIndices(out)).toEqual([{ count: 1, p: [0, 1, 2] }]);
  });
});

describe('preprocess', () => {
  it('replaces every <instance_node> with a placeholder and remembers the target', () => {
    const { text, refs } = preprocess(readFixture('merge.dae'));
    expect(refs).toEqual([{ file: '', id: 'inner' }, { file: '', id: 'inner' }]);
    expect(text).not.toContain('<instance_node');
    expect(text).toContain('<node id="__ref_0" name="@__ref_0"/>');
  });

  it('keeps the file part of references into other files', () => {
    expect(preprocess(readFixture('xref/assembly.dae')).refs).toEqual([{ file: 'part.dae', id: 'part_node' }]);
  });

  it('gives nodes without id an id, and sid-only nodes their sid', () => {
    const anon = preprocess(readFixture('anonymous.dae')).text;
    expect(anon).toContain('<node id="__node_0" name="@__node_0">');
    expect(anon).toContain('<node id="__node_1" name="@__node_1">');
    expect(preprocess(readFixture('arm_flat.dae')).text).toContain('<node id="sid:tool0" sid="tool0" name="@sid:tool0">');
  });

  it('removes the kinematics scene that three.js cannot handle', () => {
    const { text } = preprocess(readFixture('arm_flat.dae'));
    expect(text).not.toContain('instance_kinematics_scene');
    expect(text).toContain('<instance_visual_scene url="#arm_scene"/>');
  });
});
