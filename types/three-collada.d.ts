// three.js ships its COLLADA parser and composer as internal modules without type
// declarations. Only the parts used here are declared.
declare module 'three/addons/loaders/collada/ColladaParser.js' {
  export class ColladaParser {
    parse(text: string): { library: ColladaLibrary; asset: { unit: number; upAxis: string }; collada: Element } | null;
  }
  export interface ColladaLibrary {
    nodes: Record<string, unknown>;
    [key: string]: unknown;
  }
}

declare module 'three/addons/loaders/collada/ColladaComposer.js' {
  import type { Group, Object3D, TextureLoader } from 'three';
  import type { ColladaLibrary } from 'three/addons/loaders/collada/ColladaParser.js';
  export class ColladaComposer {
    constructor(library: ColladaLibrary, collada: Element, textureLoader: TextureLoader, tgaLoader: unknown);
    compose(): { scene: Group };
    getNode(id: string): Object3D;
  }
}
