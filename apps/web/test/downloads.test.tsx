// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadsPanel } from '../src/features/report/DownloadsPanel.tsx';
import { pl } from '../src/i18n/pl.ts';
import { setFetch } from '../src/lib/api.ts';
import { personaFiles } from './fixtures/persona-report.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const calls: { path: string; headers: Record<string, string> }[] = [];
const clicked: { href: string; download: string }[] = [];
const created = vi.fn<(blob: Blob) => string>(() => 'blob:olcys-test');
const revoked = vi.fn<(url: string) => void>();

beforeEach(() => {
  calls.length = 0;
  clicked.length = 0;
  created.mockClear();
  revoked.mockClear();
  URL.createObjectURL = created;
  URL.revokeObjectURL = revoked;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download });
  });
  setFetch(async (input, init) => {
    calls.push({ path: input, headers: { ...(init?.headers as Record<string, string>) } });
    return new Response('plik', { status: 200 });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<DownloadsPanel files={personaFiles} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const button = (label: string) =>
  host.querySelector(`button[aria-label="${pl.report.downloads.download}: ${label}"]`) as HTMLButtonElement;
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

describe('downloads panel', () => {
  it('shows the SHA-256 digest of every available file and the size', () => {
    for (const file of personaFiles.filter((f) => f.available)) {
      expect(host.textContent).toContain(file.sha256 ?? 'missing');
    }
    expect(host.textContent).toContain(pl.report.downloads.kinds.stix);
    expect(host.textContent).toContain('cap-1'.slice(0, 8));
  });

  it('lists an unavailable PDF as disabled with the reason', () => {
    const pdf = button(pl.report.downloads.kinds.pdf);
    expect(pdf.disabled).toBe(true);
    expect(host.textContent).toContain(pl.report.downloads.pdfUnavailable);
  });

  it('downloads without a purpose: no purpose header, a named download, the object URL is revoked', async () => {
    act(() => button(pl.report.downloads.kinds.html).click());
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/runs/run-1/report');
    expect(Object.keys(calls[0]?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('x-olcys-purpose');
    expect(created).toHaveBeenCalledOnce();
    expect(clicked).toEqual([{ href: 'blob:olcys-test', download: 'olcys-raport-run-1.html' }]);
    expect(revoked).toHaveBeenCalledWith('blob:olcys-test');
  });

  it('sends a filled-in purpose as the X-Olcys-Purpose header', async () => {
    const input = host.querySelector('input[type="text"]') as HTMLInputElement;
    expect(host.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(pl.report.downloads.purposeLabel);
    const purpose = 'Przekazanie do akt sprawy kontrolnej';
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, purpose);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button(pl.report.downloads.kinds.stix).click());
    await flush();
    expect(calls[0]?.path).toBe('/api/runs/run-1/exports/stix');
    expect(calls[0]?.headers['X-Olcys-Purpose']).toBe(encodeURIComponent(purpose));
    expect(decodeURIComponent(calls[0]?.headers['X-Olcys-Purpose'] ?? '')).toBe(purpose);
  });

  it('says so when the download fails and keeps working afterwards', async () => {
    setFetch(async () => new Response('', { status: 500 }));
    act(() => button(pl.report.downloads.kinds.manifest).click());
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(pl.report.downloads.failed);
    expect(clicked).toEqual([]);
  });
});
