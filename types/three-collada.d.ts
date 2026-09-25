// three.js ships its COLLADA parser and composer as internal modules without type
// declarations. Only the parts used here are declared.
declare module 'three/addons/loaders/collada/ColladaParser.js' {
  export interface ColladaLibrary {
    nodes: Record<string, unknown>;
    [key: string]: unknown;
  }
  export interface ColladaSource {
    array: ArrayLike<number>;
    stride: number;
  }
  export interface ColladaPrimitive {
    type: string;
    material: string | null;
    count: number;
    stride: number;
    p: ArrayLike<number>;
    vcount?: ArrayLike<number>;
    [key: string]: unknown;
  }
  export class ColladaParser {
    parse(text: string): { library: ColladaLibrary; asset: { unit: number; upAxis: string }; collada: Element } | null;
    parseSource(xml: Element): ColladaSource;
    parseGeometryPrimitive(xml: Element): ColladaPrimitive;
  }
}

declare module 'three/addons/loaders/collada/ColladaComposer.js' {
  import type { Group, Object3D, TextureLoader } from 'three';
  import type { ColladaLibrary } from 'three/addons/loaders/collada/ColladaParser.js';
  export class ColladaComposer {
    constructor(library: ColladaLibrary, collada: Element, textureLoader: TextureLoader, tgaLoader: unknown);
    compose(): { scene: Group };
    buildGeometry(data: unknown): unknown;
    getNode(id: string): Object3D;
  }
}
