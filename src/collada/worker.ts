// Web Worker around offload.ts. Messages: { id, op: 'load', url } and
// { id, op: 'geometries', geometries }; answers { id, result } or { id, error }.
import { buildGeometries, loadFile, transferables } from './offload';

type Request = { id: number; op: 'load'; url: string } | { id: number; op: 'geometries'; geometries: Record<string, unknown> };

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id } = event.data;
  try {
    const result = event.data.op === 'load' ? await loadFile(event.data.url) : buildGeometries(event.data.geometries);
    (self as unknown as Worker).postMessage({ id, result }, transferables(result));
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: (e as Error).message ?? String(e) });
  }
};
