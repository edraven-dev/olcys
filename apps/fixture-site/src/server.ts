/**
 * Static server for the synthetic fixture site (no dependencies; runs in compose on node:26-alpine).
 *
 * Files are resolved from public/<variant>/ first, then public/shared/. FIXTURE_VARIANT=v1|v2 switches
 * the planted data so a re-run can demonstrate VALUE_CHANGED (wallet swapped on a profile).
 * Everything served here is SYNTHETIC; never put real people's data in public/.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const host = process.env.FIXTURE_HOST ?? '127.0.0.1';
const port = Number(process.env.FIXTURE_PORT ?? 4100);
const variant = process.env.FIXTURE_VARIANT === 'v2' ? 'v2' : 'v1';
const publicRoot = resolve(import.meta.dirname, '..', 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
};

async function resolveFile(urlPath: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  for (const base of [join(publicRoot, variant), join(publicRoot, 'shared')]) {
    const candidate = join(base, relative);
    if (candidate !== base && !candidate.startsWith(base + sep)) continue; // path traversal guard
    for (const file of [candidate, join(candidate, 'index.html')]) {
      try {
        // Sequential on purpose: the first existing file wins (variant before shared, file before index.html).
        // oxlint-disable-next-line no-await-in-loop
        if ((await stat(file)).isFile()) return file;
      } catch {
        // not here; try the next candidate
      }
    }
  }
  return undefined;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture.invalid');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(`ok ${variant}`);
    return;
  }
  const file = await resolveFile(url.pathname);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'x-olcys-fixture-variant': variant,
  });
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.info(`[fixture-site] variant ${variant} on http://${host}:${port}`);
});
