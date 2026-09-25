// Reads the parts of a CAEX document that the 3D view needs: the instance hierarchy,
// Frame attributes, COLLADA references and attachment interfaces (AutomationML Part 3,
// IEC 62714-3). Works for CAEX 2.15 and 3.0 because it only looks at local element names.

export interface Frame {
  /** Position in metres, relative to the parent element. */
  x: number; y: number; z: number;
  /** Rotation in degrees about the parent's fixed x, y and z axes, applied in that order. */
  rx: number; ry: number; rz: number;
}

export interface ColladaRef {
  interfaceId: string | null;
  name: string | null;
  /** refURI as written. */
  uri: string;
  /** The file part of refURI, relative to the AML document. */
  file: string;
  /** The node id after '#', if any. */
  fragment: string | null;
  /** explicit: the referenced COLLADA content is this element's geometry.
   *  implicit: the element stands for a node inside another element's geometry. */
  refType: 'explicit' | 'implicit';
  /** For frame elements: a sid inside the referenced node (attachment point, frame of interest). */
  target: string | null;
}

export interface AmlAttribute {
  name: string | null;
  value: string | null;
  unit: string | null;
  children: AmlAttribute[];
}

export interface AmlElement {
  id: string;
  name: string;
  systemUnit: string | null;
  roles: string[];
  frame: Frame | null;
  attributes: AmlAttribute[];
  collada: ColladaRef[];
  attachments: { id: string; name: string }[];
  children: AmlElement[];
  parent: AmlElement | null;
}

export interface AmlInterfaceInfo {
  element: AmlElement;
  name: string;
  kind: string;
}

export interface AmlLink {
  name: string | null;
  a: string | null;
  b: string | null;
  sideA: AmlInterfaceInfo | null;
  sideB: AmlInterfaceInfo | null;
}

export interface AmlDocument {
  schemaVersion: string | null;
  hierarchies: { id: string | null; name: string | null; children: AmlElement[] }[];
  byId: Map<string, AmlElement>;
  links: AmlLink[];
}

const kids = (el: Element, name: string) => Array.from(el.children).filter(c => c.localName === name);
const kid = (el: Element, name: string) => kids(el, name)[0];
const lastSegment = (p: string | null) => (p || '').split('/').pop() || '';

function attribute(el: Element, name: string): Element | undefined {
  return kids(el, 'Attribute').find(a => a.getAttribute('Name') === name);
}

function value(attr: Element | undefined): string | null {
  const v = attr && kid(attr, 'Value');
  return v ? (v.textContent ?? '').trim() : null;
}

function readFrame(ie: Element): Frame | null {
  const f = attribute(ie, 'Frame');
  if (!f) return null;
  const n = (k: string) => {
    const v = parseFloat(value(attribute(f, k)) ?? '');
    return Number.isFinite(v) ? v : 0;
  };
  return { x: n('x'), y: n('y'), z: n('z'), rx: n('rx'), ry: n('ry'), rz: n('rz') };
}

function readCollada(ei: Element): ColladaRef {
  const uri = value(attribute(ei, 'refURI')) || '';
  const hash = uri.indexOf('#');
  const refType = (value(attribute(ei, 'refType')) || 'explicit').toLowerCase() === 'implicit' ? 'implicit' : 'explicit';
  return {
    interfaceId: ei.getAttribute('ID'),
    name: ei.getAttribute('Name'),
    uri,
    file: (hash < 0 ? uri : uri.slice(0, hash)).replace(/^file:\/\/\//, './'),
    fragment: hash < 0 ? null : uri.slice(hash + 1),
    refType,
    target: value(attribute(ei, 'target')),
  };
}

function readAttributes(el: Element): AmlAttribute[] {
  return kids(el, 'Attribute').map(a => ({
    name: a.getAttribute('Name'),
    value: value(a),
    unit: a.getAttribute('Unit'),
    children: readAttributes(a),
  }));
}

export function parseAml(text: string): AmlDocument {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'CAEXFile') throw new Error('Not a CAEX document');

  const byId = new Map<string, AmlElement>();
  const interfaces = new Map<string, AmlInterfaceInfo>();
  const rawLinks: { name: string | null; a: string | null; b: string | null }[] = [];

  function walk(ie: Element, parent: AmlElement | null): AmlElement {
    const el: AmlElement = {
      id: ie.getAttribute('ID') ?? '',
      name: ie.getAttribute('Name') ?? '',
      systemUnit: ie.getAttribute('RefBaseSystemUnitPath'),
      roles: [
        ...kids(ie, 'SupportedRoleClass').map(r => lastSegment(r.getAttribute('RefRoleClassPath'))),
        ...kids(ie, 'RoleRequirements').map(r => lastSegment(r.getAttribute('RefBaseRoleClassPath'))),
      ].filter(Boolean),
      frame: readFrame(ie),
      attributes: readAttributes(ie),
      collada: [],
      attachments: [],
      children: [],
      parent,
    };
    byId.set(el.id, el);

    for (const ei of kids(ie, 'ExternalInterface')) {
      const kind = lastSegment(ei.getAttribute('RefBaseClassPath'));
      const id = ei.getAttribute('ID') ?? '';
      interfaces.set(id, { element: el, name: ei.getAttribute('Name') ?? '', kind });
      if (kind === 'COLLADAInterface') el.collada.push(readCollada(ei));
      else if (kind === 'AttachmentInterface') el.attachments.push({ id, name: ei.getAttribute('Name') ?? '' });
    }
    for (const il of kids(ie, 'InternalLink')) {
      rawLinks.push({ name: il.getAttribute('Name'), a: il.getAttribute('RefPartnerSideA'), b: il.getAttribute('RefPartnerSideB') });
    }
    for (const child of kids(ie, 'InternalElement')) el.children.push(walk(child, el));
    return el;
  }

  const hierarchies = kids(root, 'InstanceHierarchy').map(ih => ({
    id: ih.getAttribute('ID'),
    name: ih.getAttribute('Name'),
    children: kids(ih, 'InternalElement').map(ie => walk(ie, null)),
  }));

  // CAEX 3.0 links point at the interface ID. CAEX 2.15 links point at
  // "ElementID:InterfaceName", optionally bracketed as "[ElementID]:[InterfaceName]"
  // or "{ElementID}:InterfaceName".
  function resolvePartner(ref: string | null): AmlInterfaceInfo | null {
    if (!ref) return null;
    const direct = interfaces.get(ref);
    if (direct) return direct;
    const m = /^[[{]?([^\]}:]+)[\]}]?:\[?(.+?)\]?$/.exec(ref);
    if (!m) return null;
    const owner = byId.get(m[1]);
    if (!owner) return null;
    for (const info of interfaces.values()) if (info.element === owner && info.name === m[2]) return info;
    return null;
  }

  const links = rawLinks.map(l => ({ ...l, sideA: resolvePartner(l.a), sideB: resolvePartner(l.b) }));
  return { schemaVersion: root.getAttribute('SchemaVersion'), hierarchies, byId, links };
}
