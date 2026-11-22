import { describe, expect, it } from 'vitest';
import { buildViews } from '../src/views/build.ts';
import { decodeArtifact } from '../src/views/decode.ts';
import { blockOf, segmentAt } from '../src/views/segments.ts';
import { htmlCapture, jsonCapture, textCapture, viewsOf } from './helpers.ts';

/** windows-1250 bytes of „Mój portfel” (ó = 0xF3). */
const MOJ_PORTFEL_1250 = Uint8Array.from([0x4d, 0xf3, 0x6a, 0x20, 0x70, 0x6f, 0x72, 0x74, 0x66, 0x65, 0x6c]);

describe('decodeArtifact', () => {
  it('uses the charset of the media type (windows-1250)', () => {
    const { text, encoding } = decodeArtifact(MOJ_PORTFEL_1250, 'text/html; charset=windows-1250');
    expect(text).toBe('Mój portfel');
    expect(encoding).toBe('windows-1250');
  });

  it('prescans <meta charset> when the media type has none', () => {
    const head = new TextEncoder().encode('<meta charset="windows-1250"><p>');
    const bytes = new Uint8Array([...head, ...MOJ_PORTFEL_1250]);
    expect(decodeArtifact(bytes, 'text/html').text).toBe('<meta charset="windows-1250"><p>Mój portfel');
  });

  it('lets a UTF-8 BOM override a conflicting <meta charset>', () => {
    const body = new TextEncoder().encode('<meta charset="windows-1250"><p>Mój portfel</p>');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    const { text, encoding } = decodeArtifact(bytes, 'text/html');
    expect(encoding).toBe('utf-8');
    expect(text).toContain('Mój portfel');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('falls back to UTF-8 for unknown labels', () => {
    expect(decodeArtifact(new TextEncoder().encode('ok'), 'text/plain; charset=x-unknown').encoding).toBe('utf-8');
  });
});

describe('HTML views', () => {
  it('joins inline elements in inline_joined and separates them in visible_text, with source ranges', () => {
    const html = '<p>Mój portfel: <span>bc1q</span><span>wxyz2tvdw0s3</span></p>';
    const { visible_text: visible, inline_joined: joined } = viewsOf(html);
    expect(joined?.text).toContain('bc1qwxyz2tvdw0s3');
    expect(visible?.text).toContain('bc1q wxyz2tvdw0s3');
    const segment = visible?.segments.find((s) => visible.text.slice(s.start, s.end) === 'bc1q');
    expect(segment?.source).toBeDefined();
    expect(html.slice(segment?.source?.start, segment?.source?.end)).toBe('bc1q');
  });

  it('puts block boundaries on new lines and skips scripts, styles and comments', () => {
    const { visible_text: visible } = viewsOf(
      '<div>Pierwszy</div><style>.x{}</style><!-- komentarz --><script>var a = 1;</script><p>Drugi<br>Trzeci</p>',
    );
    expect(visible?.text).toBe('Pierwszy\nDrugi\nTrzeci');
  });

  it('builds attribute, meta and json_ld views', () => {
    const html = `<html><head><title>Profil testowy</title><meta name="description" content="Opis profilu">
      <script type="application/ld+json">{"@type":"DonateAction","recipient":{"address":"X-PLACEHOLDER"}}</script></head>
      <body><a href="https://example.org/a" title="Link testowy" data-wallet="placeholder">wpłać</a></body></html>`;
    const views = viewsOf(html);
    expect(views.attribute?.text.split('\n')).toEqual(['https://example.org/a', 'Link testowy', 'placeholder']);
    expect(views.attribute?.segments.map((s) => s.attribute)).toEqual(['href', 'title', 'data-wallet']);
    expect(views.meta?.text.split('\n')).toEqual(['Profil testowy', 'Opis profilu']);
    const json = views.json_ld;
    const segment = json?.segments.find((s) => json.text.slice(s.start, s.end) === 'X-PLACEHOLDER');
    expect(segment?.jsonPointer).toBe('/recipient/address');
    expect(html.slice(segment?.source?.start, segment?.source?.end)).toBe('X-PLACEHOLDER');
  });

  it('keeps invalid JSON-LD as one raw segment with a warning', () => {
    const views = viewsOf('<script type="application/ld+json">{"broken": </script><p>tekst</p>');
    expect(views.json_ld?.segments).toHaveLength(1);
    expect(views.json_ld?.warnings).toContain('json_parse_failed');
  });

  it('marks code, quotes, labels, anchors and containers on forum-like and channel-like markup', () => {
    const html = `<body>
      <div class="olcys-synthetic" role="note">DANE SYNTETYCZNE — SYNTHETIC TEST DATA</div>
      <table><tr><td><b>Bitcoin address: </b></td><td>PROFILE-VALUE</td></tr></table>
      <a name="msg65000101"></a>
      <table><tr><td class="td_headerandpost">
        <div class="post">Wpis forum
          <div class="quoteheader"><a href="#">Quote from: fikcyjny_kacper on November 01, 2026</a></div>
          <div class="quote">CYTOWANY-TEKST</div>
          <div class="codeheader">Code:</div><div class="code">KOD-LINIA-1<br />KOD-LINIA-2</div>
        </div>
      </td></tr></table>
      <div class="tgme_widget_message" data-post="olcys_test_ostrzezenia/101">
        <div class="tgme_widget_message_text">KANAL-TEKST</div>
      </div>
    </body>`;
    const { visible_text: v } = viewsOf(html);
    if (!v) throw new Error('no visible view');
    const at = (needle: string) => segmentAt(v, v.text.indexOf(needle));
    expect(at('KOD-LINIA-1')?.inCode).toBe(true);
    expect(v.text).toContain('KOD-LINIA-1\nKOD-LINIA-2');
    expect(at('CYTOWANY-TEKST')?.quoted).toBe(true);
    expect(at('Wpis forum')?.quoted).toBe(false);
    expect(blockOf(v, at('PROFILE-VALUE'))?.structuralLabel).toBe('Bitcoin address');
    expect(at('Wpis forum')?.anchor).toBe('msg65000101');
    expect(at('KANAL-TEKST')?.anchor).toBe('olcys_test_ostrzezenia/101');
    expect(at('DANE SYNTETYCZNE')?.container).not.toBe(at('Wpis forum')?.container);
    expect(at('KANAL-TEKST')?.container).not.toBe(at('Wpis forum')?.container);
    expect(at('CYTOWANY-TEKST')?.container).toBe(at('Wpis forum')?.container);
  });

  it('records the heading path and hidden flags', () => {
    const { visible_text: v } = viewsOf(
      '<h1>Profil</h1><h2>Portfele</h2><p>TEKST-A</p><p hidden>UKRYTE</p><p style="display: none">TEZ-UKRYTE</p>',
    );
    if (!v) throw new Error('no visible view');
    const segment = segmentAt(v, v.text.indexOf('TEKST-A'));
    expect(blockOf(v, segment)?.headingPath).toEqual(['Profil', 'Portfele']);
    expect(segmentAt(v, v.text.indexOf('UKRYTE'))?.hidden).toBe(true);
    expect(segmentAt(v, v.text.indexOf('TEZ-UKRYTE'))?.hidden).toBe(true);
    expect(segment?.hidden).toBe(false);
  });

  it('removes code text from inline_joined', () => {
    const { inline_joined: joined } = viewsOf('<p>przed</p><pre>KOD</pre><p>po</p>');
    expect(joined?.text).toBe('przed\npo');
  });
});

describe('JSON and text artifacts', () => {
  it('walks JSON string values with pointers; keys appear only in pointers', () => {
    const json = '{"drips":{"ethereum":{"ownedBy":"VALUE-1"}},"list":["A-1","B-2"],"n":5}';
    const [view] = buildViews(jsonCapture(json));
    expect(view?.view).toBe('json_ld');
    expect(view?.text).toBe('VALUE-1\nA-1\nB-2');
    expect(view?.segments.map((s) => s.jsonPointer)).toEqual(['/drips/ethereum/ownedBy', '/list/0', '/list/1']);
    const [a, b] = [view?.segments[1], view?.segments[2]];
    expect(a?.container).toBe(b?.container);
  });

  it('gives text artifacts one segment per line', () => {
    const [view] = buildViews(textCapture('linia 1\r\nlinia 2\n\nlinia 3'));
    expect(view?.text).toBe('linia 1\nlinia 2\nlinia 3');
    expect(view?.segments).toHaveLength(3);
    expect(view?.segments[1]?.source).toEqual({ start: 9, end: 16 });
  });

  it('ignores screenshots and other artifact kinds', () => {
    const capture = htmlCapture('<p>x</p>');
    capture.artifacts.push({ kind: 'screenshot', mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    expect(buildViews(capture).every((v) => v.artifactIndex === 0)).toBe(true);
  });
});
