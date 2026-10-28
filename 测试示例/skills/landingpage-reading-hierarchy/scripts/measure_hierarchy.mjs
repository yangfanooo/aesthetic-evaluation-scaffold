/**
 * 阅读层级取证。只输出字号、字重和位置，不打分。
 * 用法: node measure_hierarchy.mjs <page.html> [--desktop-only]
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const htmlPath = process.argv[2];
const desktopOnly = process.argv.includes('--desktop-only');

if (!htmlPath || !fs.existsSync(htmlPath)) {
  console.error('用法: node measure_hierarchy.mjs <page.html> [--desktop-only]');
  process.exit(2);
}

const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 900 }];
if (!desktopOnly) VIEWPORTS.push({ name: 'mobile', width: 390, height: 844 });

function extract({ viewportHeight }) {
  const INLINE = new Set([
    'SPAN', 'STRONG', 'EM', 'B', 'I', 'SMALL', 'MARK', 'BR', 'WBR',
    'SUB', 'SUP', 'CITE', 'CODE', 'ABBR', 'TIME', 'U', 'S', 'A',
  ]);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'HEAD']);

  const round1 = (n) => Math.round(n * 10) / 10;

  function weightOf(value) {
    if (value === 'bold') return 700;
    if (value === 'normal') return 400;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : 400;
  }

  function visible(el, style) {
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    return true;
  }

  function isCarrier(el) {
    for (const child of el.children) {
      if (!INLINE.has(child.tagName)) return false;
    }
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    return text.length > 0;
  }

  function containerOf(el) {
    const sec = el.closest('section, article, header, footer');
    if (!sec) return 'body';
    const id = sec.id ? `#${sec.id}` : '';
    const cls = typeof sec.className === 'string'
      ? sec.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join('')
      : '';
    return sec.tagName.toLowerCase() + id + cls;
  }

  const raw = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (SKIP.has(el.tagName) || !isCarrier(el)) continue;
    const style = getComputedStyle(el);
    if (!visible(el, style)) continue;
    const rect = el.getBoundingClientRect();
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const fontSize = Number.parseFloat(style.fontSize);
    raw.push({
      el,
      text,
      textLength: text.length,
      tag: el.tagName.toLowerCase(),
      fontSize: round1(fontSize),
      fontWeight: weightOf(style.fontWeight),
      x: round1(rect.left + window.scrollX),
      y: round1(rect.top + window.scrollY),
      width: round1(rect.width),
      height: round1(rect.height),
      container: containerOf(el),
      inNav: Boolean(el.closest('nav, [role="navigation"]')),
      inButton: Boolean(el.closest('button, [role="button"]')) || el.tagName === 'BUTTON',
      fixed: style.position === 'fixed' || style.position === 'sticky',
    });
  }

  const depthOf = (el) => {
    let depth = 0;
    for (let node = el; node; node = node.parentElement) depth += 1;
    return depth;
  };
  raw.sort((a, b) => depthOf(a.el) - depthOf(b.el));
  const kept = [];
  for (const item of raw) {
    const parent = kept.find((other) => other.el.contains(item.el));
    if (parent && parent.text.includes(item.text)) {
      if (parent.fontSize !== item.fontSize || parent.fontWeight !== item.fontWeight) {
        if (parent.text === item.text) {
          parent.fontSize = item.fontSize;
          parent.fontWeight = item.fontWeight;
        }
      }
      continue;
    }
    kept.push(item);
  }

  kept.sort((a, b) => a.y - b.y || a.x - b.x);
  const blocks = [];
  for (const item of kept) {
    const prev = blocks[blocks.length - 1];
    if (prev && prev.text === item.text && prev.fontSize === item.fontSize && Math.abs(prev.y - item.y) < 2 && Math.abs(prev.x - item.x) < 2) {
      continue;
    }
    const { el, ...rest } = item;
    rest.text = item.text.slice(0, 80);
    rest.inFirstViewport = item.y < viewportHeight && item.y + item.height > 0;
    blocks.push(rest);
    if (blocks.length >= 400) break;
  }

  const flow = blocks.filter((b) => !b.fixed);
  const tierMap = new Map();
  for (const block of flow) {
    if (block.inNav) continue;
    const key = `${block.fontSize}/${block.fontWeight}`;
    if (!tierMap.has(key)) {
      tierMap.set(key, { fontSize: block.fontSize, fontWeight: block.fontWeight, count: 0, samples: [] });
    }
    const tier = tierMap.get(key);
    tier.count += 1;
    if (tier.samples.length < 3) tier.samples.push(block.text);
  }
  const tiers = [...tierMap.values()].sort((a, b) => b.fontSize - a.fontSize || b.fontWeight - a.fontWeight);

  const firstScreen = flow.filter((b) => b.inFirstViewport).slice(0, 40);
  const sectionMap = new Map();
  for (const block of flow) {
    if (block.inNav) continue;
    if (!sectionMap.has(block.container)) sectionMap.set(block.container, []);
    sectionMap.get(block.container).push({
      text: block.text,
      tag: block.tag,
      fontSize: block.fontSize,
      fontWeight: block.fontWeight,
      y: block.y,
      inButton: block.inButton,
    });
  }
  const sections = [...sectionMap.entries()].map(([container, items]) => ({ container, blocks: items }));
  const heroBox = { x: 0, y: 0, w: window.innerWidth, h: viewportHeight * 0.85 };
  let heroImage = false;
  for (const el of document.body.querySelectorAll('img, section, header, div')) {
    const style = getComputedStyle(el);
    const hasImage = el.tagName === 'IMG' || (style.backgroundImage && style.backgroundImage !== 'none');
    if (!hasImage) continue;
    const rect = el.getBoundingClientRect();
    const overlapW = Math.min(rect.right, heroBox.w) - Math.max(rect.left, 0);
    const overlapH = Math.min(rect.bottom, heroBox.h) - Math.max(rect.top, 0);
    if (overlapW > heroBox.w * 0.45 && overlapH > heroBox.h * 0.35) {
      heroImage = true;
      break;
    }
  }
  const heroHasLargeText = firstScreen.some((b) => !b.inNav && b.fontSize >= 28);

  return {
    fontsStatus: document.fonts.status,
    truncated: kept.length > blocks.length,
    blockCount: blocks.length,
    heroTextMayBeInImage: heroImage && !heroHasLargeText,
    tiers,
    sections,
    firstScreen,
    blocks,
  };
}

async function settle(page, viewportHeight) {
  await page.evaluate(() => document.fonts.ready);
  const scrollHeight = await page.evaluate(() => Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight,
  ));
  for (let y = 0; y < scrollHeight; y += viewportHeight) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(40);
  return scrollHeight;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const target = pathToFileURL(path.resolve(htmlPath)).href;
  await page.goto(target, { waitUntil: 'load', timeout: 20000 });

  const viewports = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const scrollHeight = await settle(page, viewport.height);
    const measured = await page.evaluate(extract, { viewportHeight: viewport.height });
    viewports.push({ ...viewport, scrollHeight, ...measured });
  }

  process.stdout.write(`${JSON.stringify({
    source: path.resolve(htmlPath),
    standard: '落地页排版评测标准 v0.1',
    angle: 'A.阅读层级',
    viewports,
  }, null, 2)}\n`);
} catch (error) {
  console.error(`无法打开或测量页面: ${error.message}`);
  process.exit(1);
} finally {
  await browser.close();
}
