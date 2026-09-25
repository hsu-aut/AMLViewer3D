import { preprocess, stripIndices, ARRAY_TOKEN } from '../src/collada/preprocess';
import { readFixture } from './helpers';

const ints = (...v: number[]) => Int32Array.from(v);
const list = (a: Int32Array) => Array.from(a);

describe('stripIndices', () => {
  it('turns a strip of n vertices into n - 2 triangles with alternating order', () => {
    expect(list(stripIndices('tristrips', [ints(0, 1, 2, 3, 4)], 1))).toEqual([0, 1, 2, 2, 1, 3, 2, 3, 4]);
  });

  it('turns a fan into triangles around the first vertex', () => {
    expect(list(stripIndices('trifans', [ints(9, 1, 2, 3, 4)], 1))).toEqual([9, 1, 2, 9, 2, 3, 9, 3, 4]);
  });

  it('keeps whole vertices when several inputs share an index list', () => {
    expect(list(stripIndices('tristrips', [ints(0, 7, 1, 7, 2, 7, 3, 7)], 2))).toEqual([0, 7, 1, 7, 2, 7, 2, 7, 1, 7, 3, 7]);
  });

  it('drops triangles with a repeated vertex and joins all lists', () => {
    expect(list(stripIndices('tristrips', [ints(0, 1, 2), ints(0, 1, 1, 2)], 1))).toEqual([0, 1, 2]);
  });
});

describe('preprocess', () => {
  it('moves number lists into typed arrays and leaves tokens', () => {
    const { text, reduced, arrays } = preprocess(readFixture('merge.dae'));
    expect(text).not.toMatch(/<float_array[^>]*>[\d.\s-]+</);
    expect(reduced).toMatch(/<float_array id="cube_pos_a" count="24">§0<\/float_array>/);
    expect(arrays[0]).toBeInstanceOf(Float32Array);
    expect(arrays[0]).toHaveLength(24);
    expect(arrays[1]).toBeInstanceOf(Int32Array);
    expect(arrays[1]).toHaveLength(36);
  });

  it('rewrites strips and fans as triangles on the arrays', () => {
    const { text, arrays } = preprocess(readFixture('strips.dae'));
    expect(text).not.toMatch(/tristrips|trifans/);
    const tris = [...text.matchAll(/<triangles\b[^>]*count="(\d+)"[^>]*>[\s\S]*?<p>([^<]*)<\/p>/g)].map(m => [+m[1], arrays[+ARRAY_TOKEN.exec(m[2])![1]].length]);
    // 4 triangles from the strip, 3 from the fan, two inputs per vertex
    expect(tris).toEqual([[4, 24], [3, 18]]);
  });

  it('rewrites polygons with one <p> each as a polylist', () => {
    const { text, arrays } = preprocess(readFixture('polygons.dae'));
    expect(text).not.toContain('<polygons');
    const m = /<polylist\b[^>]*count="(\d+)"[^>]*>[\s\S]*?<vcount>([^<]*)<\/vcount><p>([^<]*)<\/p>/.exec(text)!;
    expect(+m[1]).toBe(2);
    expect(list(arrays[+ARRAY_TOKEN.exec(m[2])![1]] as Int32Array)).toEqual([4, 3]);
    expect(list(arrays[+ARRAY_TOKEN.exec(m[3])![1]] as Int32Array)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

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

  it('removes the kinematics scene for three.js and keeps it in the reduced text', () => {
    const { text, reduced } = preprocess(readFixture('arm_flat.dae'));
    expect(text).not.toContain('instance_kinematics_scene');
    expect(text).toContain('<instance_visual_scene url="#arm_scene"/>');
    expect(reduced).toContain('<instance_kinematics_scene url="#arm_kin_scene">');
  });
});
