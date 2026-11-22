import type { DomNode } from '../lib/dom.ts';

/**
 * Caption overlay of the demo video. It is injected by Playwright (an init script: it survives reloads and bypasses
 * the page's CSP) and styled through the CSSOM (`element.style.x = …`), never by touching the app. Plain strings, so no
 * DOM typings are needed in the TypeScript program.
 */
export const OVERLAY_INIT_SCRIPT = `
(() => {
  const KEY = '__olcys_video_caption';
  const state = { title: '', detail: '', fast: '', card: null };
  try { Object.assign(state, JSON.parse(sessionStorage.getItem(KEY) || '{}')); } catch {}
  let bar, badge, card, built = false;
  const css = (el, props) => { for (const [k, v] of Object.entries(props)) el.style[k] = v; return el; };
  const font = '"Noto Sans", "Segoe UI", system-ui, sans-serif';
  function build() {
    if (built || !document.body) return;
    built = true;
    document.documentElement.style.scrollBehavior = 'smooth';
    document.body.style.paddingBottom = '120px';
    badge = css(document.createElement('div'), {
      position: 'fixed', top: '10px', right: '14px', zIndex: '2147483647', pointerEvents: 'none',
      background: '#7c2d12', color: '#fff', font: '700 15px ' + font, letterSpacing: '0.06em',
      padding: '6px 14px', borderRadius: '999px', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
    });
    bar = css(document.createElement('div'), {
      position: 'fixed', left: '0', right: '0', bottom: '0', zIndex: '2147483646', pointerEvents: 'none',
      background: 'rgba(15,23,42,.94)', color: '#fff', padding: '14px 32px 16px', font: '400 20px ' + font,
      borderTop: '4px solid #f59e0b',
    });
    card = css(document.createElement('div'), {
      position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none', display: 'none',
      background: 'linear-gradient(135deg,#0f172a,#1e3a8a)', color: '#fff', font: '400 30px ' + font,
      alignItems: 'center', justifyContent: 'center', flexDirection: 'column', textAlign: 'center', padding: '48px',
    });
    document.body.append(bar, badge, card);
    render();
  }
  function render() {
    if (!built) return;
    badge.textContent = state.badge || '';
    badge.style.display = state.badge ? 'block' : 'none';
    bar.textContent = '';
    bar.style.display = state.title ? 'block' : 'none';
    const h = css(document.createElement('div'), { font: '700 28px ' + font });
    h.textContent = state.title;
    const d = css(document.createElement('div'), { marginTop: '4px', opacity: '0.9' });
    d.textContent = state.detail + (state.fast ? '  ·  ' + state.fast : '');
    bar.append(h, d);
    card.textContent = '';
    card.style.display = state.card ? 'flex' : 'none';
    if (state.card) {
      const t = css(document.createElement('div'), { font: '700 52px ' + font, maxWidth: '1500px' });
      t.textContent = state.card.title;
      const s = css(document.createElement('div'), { marginTop: '24px', opacity: '0.9' });
      s.textContent = state.card.subtitle;
      const b = css(document.createElement('div'), {
        marginTop: '40px', background: '#7c2d12', padding: '8px 22px', borderRadius: '999px', font: '700 20px ' + font,
      });
      b.textContent = state.badge;
      card.append(t, s, b);
    }
  }
  window.__olcysCaption = (patch) => {
    Object.assign(state, patch);
    try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch {}
    build();
    render();
  };
  document.addEventListener('DOMContentLoaded', build);
  if (document.readyState !== 'loading') build();
})();
`;

/** Outlines an element (CSSOM only, no stylesheet or attribute edits). */
export const mark = (el: DomNode): void => {
  el.style['transition'] = 'outline-color .3s, box-shadow .3s';
  el.style['outline'] = '5px solid #f59e0b';
  el.style['outlineOffset'] = '6px';
  el.style['boxShadow'] = '0 0 0 10px rgba(245,158,11,.25)';
};
export const unmark = (el: DomNode): void => {
  el.style['outline'] = '';
  el.style['outlineOffset'] = '';
  el.style['boxShadow'] = '';
};
export const scrollToMiddle = (el: DomNode): void => el.scrollIntoView({ behavior: 'smooth', block: 'center' });
