import { describe, expect, it } from 'vitest';
import { assertSelfContainedHtml, ExternalReferenceError, renderReport } from '../src/index.ts';
import { personaData } from './fixtures.ts';

const report = renderReport(personaData());
const inject = (fragment: string) => report.replace('</body>', `${fragment}</body>`);

describe('assertSelfContainedHtml', () => {
  it('accepts the rendered report, in-document anchors and data: images', () => {
    expect(() => assertSelfContainedHtml(report)).not.toThrow();
    expect(() =>
      assertSelfContainedHtml(inject('<a href="#metryka">x</a><img src="data:image/png;base64,AAAA">')),
    ).not.toThrow();
    // Escaped scraped text may contain attribute-like text; it is not markup.
    expect(() =>
      assertSelfContainedHtml(inject('<p>&lt;img src=https://example.org/x.png&gt; url(https://x)</p>')),
    ).not.toThrow();
  });

  it.each([
    '<link href="https://example.org/x.css" rel="stylesheet">',
    '<script>alert(1)</script>',
    '<img src="https://example.org/pixel.png">',
    '<a href="https://example.org/">link</a>',
    '<p style="background:url(https://example.org/x.png)">x</p>',
    '<iframe src="about:blank"></iframe>',
    '<style>@import "https://example.org/x.css";</style>',
  ])('rejects %s', (fragment) => {
    expect(() => assertSelfContainedHtml(inject(fragment))).toThrow(ExternalReferenceError);
  });

  it('requires the Content-Security-Policy meta element', () => {
    expect(() => assertSelfContainedHtml(report.replace(/<meta http-equiv[^>]*>/, ''))).toThrow(
      /Content-Security-Policy/,
    );
  });
});
