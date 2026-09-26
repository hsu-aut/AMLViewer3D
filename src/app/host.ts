// The page's side of the bridge to a host application (the AutomationML Editor plugin,
// through WebView2's chrome.webview). Without a host, isHosted is false and posts go
// nowhere.
//
// page -> host
//   { type: 'ready', url }                       the page listens now
//   { type: 'loaded', ticket, summary, problems }  a document is shown; the ticket it came with
//   { type: 'selected', id }                     the user picked an element
//   { type: 'log', level, message }
//   { type: 'error', message }
// host -> page
//   { type: 'open', aml, base, name, ticket, drive }
//                                                AML text, folder URL of the file, file name,
//                                                a number for "loaded", the drive served ("C:")
//   { type: 'clear' }                            no document
//   { type: 'select', id }                       the editor selected an element (null: nothing)
//   { type: 'setTheme', theme: 'dark' | 'light' }

interface WebView {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

const webview = (globalThis as unknown as { chrome?: { webview?: WebView } }).chrome?.webview;

export const isHosted = !!webview;

export type HostMessage =
  | { type: 'open'; aml: string; base: string; name: string; ticket?: number; drive?: string | null }
  | { type: 'clear' }
  | { type: 'select'; id: string | null }
  | { type: 'setTheme'; theme: 'dark' | 'light' };

export function post(message: Record<string, unknown>): void {
  webview?.postMessage(message);
}

export function onHostMessage(handler: (message: HostMessage) => void): void {
  webview?.addEventListener('message', event => {
    const data = event.data as HostMessage | null;
    if (data && typeof data === 'object' && 'type' in data) handler(data);
  });
}
