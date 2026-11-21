/**
 * Access-barrier detection on a fetched response. A CAPTCHA, browser challenge, login wall, block or rate limit ends
 * collection from that source: OŁCyŚ records it and moves on — it never solves, retries around or evades a barrier.
 * Priority: captcha > login_wall > blocked. A false positive only stops the source.
 */
import type { CaptureStatus } from '@olcys/core';
import { blockText, parseHtml } from './dom.ts';

export interface BarrierInput {
  status: number;
  /** Lower-case header names. */
  headers: Readonly<Record<string, string>>;
  finalUrl: string;
  html: string;
}

export interface BarrierVerdict {
  /** `ok` when no barrier was found. */
  status: CaptureStatus;
  signals: string[];
}

const CAPTCHA_MARKUP = [
  'g-recaptcha',
  'google.com/recaptcha',
  'hcaptcha.com',
  'h-captcha',
  'cf-turnstile',
  'challenges.cloudflare.com',
  'cf-chl-',
  'captcha-delivery.com',
  'px-captcha',
  'arkoselabs',
];
const CAPTCHA_TEXT = [
  'just a moment',
  'verify you are human',
  'checking your browser',
  'nie jestem robotem',
  'nie jesteś robotem',
  'sprawdzanie przeglądarki',
  'weryfikacja przeglądarki',
];
const LOGIN_TEXT = [
  'log in to continue',
  'sign in to continue',
  'zaloguj się, aby',
  'only registered members are allowed',
];
const BLOCKED_MARKUP = ['_incapsula_resource'];
const BLOCKED_TEXT = ['access denied', 'you are banned'];
const LOGIN_PATH = /\/(?:login|signin|sign-in|logowanie|zaloguj|auth)\b/i;
const PASSWORD_INPUT = /<input\b[^>]*\btype\s*=\s*["']?password\b/i;
/** Content signals are only trusted on short pages or error responses (a long forum thread may discuss CAPTCHAs). */
const SHORT_PAGE_CHARS = 3000;
const LOGIN_FORM_MAX_CHARS = 300;

export function detectAccessBarrier(input: BarrierInput): BarrierVerdict {
  const captcha: string[] = [];
  const login: string[] = [];
  const blocked: string[] = [];
  const { status, headers } = input;

  if (headers['cf-mitigated']?.trim().toLowerCase() === 'challenge') captcha.push('header cf-mitigated: challenge');
  if (status === 401 || status === 407) login.push(`HTTP ${status}`);
  if (status === 403 || status === 429 || status === 451) {
    const retryAfter = headers['retry-after'];
    blocked.push(retryAfter ? `HTTP ${status} (retry-after: ${retryAfter})` : `HTTP ${status}`);
  }
  try {
    const path = new URL(input.finalUrl).pathname;
    if (LOGIN_PATH.test(path)) login.push(`login path ${path}`);
  } catch {
    // Not a URL: no path signal.
  }

  if (input.html) {
    const body = parseHtml(input.html).body;
    const text = (body ? blockText(body) : '').toLowerCase();
    if (text.length < SHORT_PAGE_CHARS || status >= 400) {
      const markup = input.html.toLowerCase();
      for (const s of CAPTCHA_MARKUP) if (markup.includes(s)) captcha.push(`markup ${s}`);
      for (const s of CAPTCHA_TEXT) if (text.includes(s)) captcha.push(`text "${s}"`);
      for (const s of LOGIN_TEXT) if (text.includes(s)) login.push(`text "${s}"`);
      if (PASSWORD_INPUT.test(input.html) && text.length < LOGIN_FORM_MAX_CHARS) login.push('password form');
      for (const s of BLOCKED_MARKUP) if (markup.includes(s)) blocked.push(`markup ${s}`);
      for (const s of BLOCKED_TEXT) if (text.includes(s)) blocked.push(`text "${s}"`);
    }
  }

  if (captcha.length) return { status: 'captcha', signals: captcha };
  if (login.length) return { status: 'login_wall', signals: login };
  if (blocked.length) return { status: 'blocked', signals: blocked };
  return { status: 'ok', signals: [] };
}
