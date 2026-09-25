// three.js' COLLADA parser, told where the number lists are: preprocess.ts replaced them
// with tokens pointing into a list of typed arrays. The parser reads the token as a
// one-element list (cheap) and the real array is put in its place.

import { ColladaParser } from 'three/addons/loaders/collada/ColladaParser.js';
import { ARRAY_TOKEN, type NumberArray } from './preprocess';

const childrenNamed = (el: Element, name: string) => Array.from(el.children).filter(c => c.localName === name);

export class ArrayColladaParser extends ColladaParser {
  constructor(private readonly arrays: NumberArray[]) {
    super();
  }

  private lookup(el: Element | undefined): NumberArray | undefined {
    const m = el ? ARRAY_TOKEN.exec(el.textContent ?? '') : null;
    return m ? this.arrays[+m[1]] : undefined;
  }

  override parseSource(xml: Element) {
    const data = super.parseSource(xml);
    const array = this.lookup(childrenNamed(xml, 'float_array')[0]);
    if (array) data.array = array;
    return data;
  }

  override parseGeometryPrimitive(xml: Element) {
    const primitive = super.parseGeometryPrimitive(xml);
    const ps = childrenNamed(xml, 'p');
    const p = this.lookup(ps[ps.length - 1]);
    if (p) primitive.p = p;
    const vcount = this.lookup(childrenNamed(xml, 'vcount')[0]);
    if (vcount) primitive.vcount = vcount;
    if (primitive.type === 'polygons') primitive.vcount = [primitive.p.length / primitive.stride];
    return primitive;
  }
}
