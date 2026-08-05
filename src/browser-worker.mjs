#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '/opt/sezu/packs/sezu-core/node/node_modules/playwright/index.mjs';

const requestPath = process.argv[2];
const resultPath = process.argv[3];
if (!requestPath || !resultPath) throw new Error('request and result paths are required');
const request = JSON.parse(await fsp.readFile(requestPath, 'utf8'));
const settings = request.profile?.settings || {};
await fsp.mkdir(request.profile_dir, { recursive: true });
await fsp.mkdir(request.output_dir, { recursive: true });
const launchOptions = {
  executablePath: process.env.SEZU_CHROMIUM_EXECUTABLE || '/opt/sezu/toolchains/playwright/chromium-1234/chrome-linux64/chrome',
  headless: request.headless !== false,
  locale: settings.locale || 'en-US',
  timezoneId: settings.timezone_id || 'America/New_York',
  viewport: settings.viewport || { width: 1440, height: 900 },
  geolocation: settings.geolocation || undefined,
  permissions: settings.permissions || [],
  userAgent: settings.user_agent || undefined,
  acceptDownloads: true,
  downloadsPath: request.output_dir
};
const context = await chromium.launchPersistentContext(request.profile_dir, launchOptions);
const cookieFile = path.join(request.profile_dir, 'sezu-cookies.json');
try {
  const savedCookies = JSON.parse(await fsp.readFile(cookieFile, 'utf8'));
  if (Array.isArray(savedCookies) && savedCookies.length) await context.addCookies(savedCookies);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
let pages = context.pages();
let page = pages[0] || await context.newPage();
const results = [];
const serializable = value => {
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
};

async function runAction(action) {
  const type = action.type || action.action;
  switch (type) {
    case 'goto': return await page.goto(action.url, { waitUntil: action.wait_until || 'load', timeout: action.timeout });
    case 'click': await page.locator(action.selector).click(action.options || {}); return { clicked: action.selector };
    case 'type': await page.locator(action.selector).type(String(action.text ?? ''), action.options || {}); return { typed: action.selector };
    case 'fill': await page.locator(action.selector).fill(String(action.value ?? action.text ?? '')); return { filled: action.selector };
    case 'press': await page.locator(action.selector || 'body').press(action.key, action.options || {}); return { pressed: action.key };
    case 'submit': await page.locator(action.selector).evaluate(el => el.requestSubmit ? el.requestSubmit() : el.submit()); return { submitted: action.selector };
    case 'drag_and_drop': await page.dragAndDrop(action.source, action.destination, action.options || {}); return { source: action.source, destination: action.destination };
    case 'evaluate': return await page.evaluate(({ expression, arg }) => {
      const fn = new Function('arg', `return (${expression})`); return fn(arg);
    }, { expression: action.expression || action.script, arg: action.arg });
    case 'dom': return await page.locator(action.selector || 'html').evaluate((el, mode) => mode === 'text' ? el.textContent : el.outerHTML, action.mode || 'html');
    case 'content': return await page.content();
    case 'title': return await page.title();
    case 'url': return page.url();
    case 'screenshot': {
      const file = path.join(request.output_dir, action.name || `screenshot-${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: action.full_page ?? true, type: action.format || undefined, ...action.options }); return { file };
    }
    case 'pdf': {
      const file = path.join(request.output_dir, action.name || `page-${Date.now()}.pdf`);
      await page.pdf({ path: file, format: action.format || 'A4', printBackground: action.print_background ?? true, ...action.options }); return { file };
    }
    case 'upload': await page.locator(action.selector).setInputFiles(action.files); return { uploaded: action.files };
    case 'wait': if (action.selector) await page.locator(action.selector).waitFor(action.options || {}); else await page.waitForTimeout(action.ms || 0); return { waited: action.selector || action.ms };
    case 'route': {
      await page.route(action.url || '**/*', async route => {
        if (action.abort) await route.abort(action.abort === true ? 'blockedbyclient' : action.abort);
        else if (action.fulfill) await route.fulfill(action.fulfill);
        else await route.continue(action.continue || {});
      }); return { route: action.url || '**/*' };
    }
    case 'unroute': await page.unroute(action.url || '**/*'); return { unroute: action.url || '**/*' };
    case 'request': {
      const response = await context.request.fetch(action.url, { method: action.method, headers: action.headers, data: action.data, timeout: action.timeout });
      const body = await response.body(); return { status: response.status(), headers: response.headers(), body_base64: body.toString('base64') };
    }
    case 'response': {
      const waiting = page.waitForResponse(action.url || (() => true), { timeout: action.timeout });
      if (action.trigger) await runAction(action.trigger);
      const response = await waiting; const body = await response.body(); return { url: response.url(), status: response.status(), headers: response.headers(), body_base64: body.toString('base64') };
    }
    case 'download': {
      const waiting = page.waitForEvent('download', { timeout: action.timeout });
      if (action.trigger) await runAction(action.trigger);
      const download = await waiting; const file = path.join(request.output_dir, action.name || download.suggestedFilename()); await download.saveAs(file); return { file, suggested_filename: download.suggestedFilename(), failure: await download.failure() };
    }
    case 'websocket': return await page.evaluate(async ({ url, protocols, messages, timeout }) => await new Promise((resolve, reject) => {
      const socket = new WebSocket(url, protocols); const received = []; const timer = setTimeout(() => { socket.close(); resolve({ received, timed_out: true }); }, timeout || 5000);
      socket.onopen = () => { for (const message of messages || []) socket.send(typeof message === 'string' ? message : JSON.stringify(message)); if (!(messages || []).length) { clearTimeout(timer); socket.close(); resolve({ received, opened: true }); } };
      socket.onmessage = event => { received.push(typeof event.data === 'string' ? event.data : String(event.data)); if (received.length >= (messages || []).length) { clearTimeout(timer); socket.close(); resolve({ received }); } };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed')); };
    }), { url: action.url, protocols: action.protocols, messages: action.messages, timeout: action.timeout });
    case 'cdp': {
      const session = await context.newCDPSession(page); try { return await session.send(action.method, action.params || {}); } finally { await session.detach(); }
    }
    case 'cookies': return await context.cookies(action.urls);
    case 'add_cookies': await context.addCookies(action.cookies || []); return { added: (action.cookies || []).length };
    case 'clear_cookies': await context.clearCookies(action.options || {}); return { cleared: true };
    case 'storage': return await page.evaluate(() => ({ localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } }));
    case 'set_storage': await page.evaluate(values => { for (const [k, v] of Object.entries(values.localStorage || {})) localStorage.setItem(k, String(v)); for (const [k, v] of Object.entries(values.sessionStorage || {})) sessionStorage.setItem(k, String(v)); }, action.values || {}); return { stored: true };
    case 'new_page': page = await context.newPage(); if (action.url) await page.goto(action.url); return { pages: context.pages().length };
    case 'select_page': pages = context.pages(); page = pages[action.index || 0]; if (!page) throw new Error(`page index not found: ${action.index}`); return { index: action.index || 0, url: page.url() };
    case 'close_page': await page.close(); pages = context.pages(); page = pages[0] || await context.newPage(); return { pages: pages.length };
    default: throw new Error(`unsupported browser action: ${type}`);
  }
}

try {
  for (let i = 0; i < (request.actions || []).length; i++) {
    const action = request.actions[i];
    try { results.push({ index: i, type: action.type || action.action, ok: true, result: serializable(await runAction(action)) }); }
    catch (error) { results.push({ index: i, type: action.type || action.action, ok: false, error: { message: error.message, stack: error.stack } }); if (action.continue_on_error !== true) throw error; }
  }
  if (request.script) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('page', 'context', 'browser', 'outputDir', request.script);
    results.push({ type: 'script', ok: true, result: serializable(await fn(page, context, context.browser(), request.output_dir)) });
  }
  await fsp.writeFile(resultPath, JSON.stringify({ ok: true, pages: context.pages().map(p => ({ url: p.url() })), results }, null, 2));
} catch (error) {
  await fsp.writeFile(resultPath, JSON.stringify({ ok: false, pages: context.pages().map(p => ({ url: p.url() })), results, error: { message: error.message, stack: error.stack } }, null, 2));
  process.exitCode = 1;
} finally {
  try { await fsp.writeFile(cookieFile, JSON.stringify(await context.cookies(), null, 2)); } catch {}
  await context.close();
}
