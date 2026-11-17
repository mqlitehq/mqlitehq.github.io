import { test, expect } from '@playwright/test';

const expected = ['overview', 'lifecycle', 'filter'];
const asset = (id) => id === 'overview' ? 'fig-overview.svg' : `concepts-${id}.svg`;

test('concepts defaults to the same three real SVG illustrations in both languages', async ({ page }) => {
  for (const locale of ['', 'zh-CN/']) {
    await page.goto(`/${locale}concepts.html`);
    const figures = page.locator('figure[data-concept-diagram]');
    await expect(figures).toHaveCount(3);
    for (const id of expected) {
      const figure = page.locator(`[data-concept-diagram="${id}"]`);
      const image = figure.locator('img');
      await expect(image).toBeVisible();
      expect(await image.evaluate((img) => new URL(img.src).pathname)).toBe(`/assets/${locale}${asset(id)}`);
      expect(await image.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
      expect(await image.getAttribute('alt')).toBeTruthy();
      await expect(figure.locator('details')).not.toHaveAttribute('open');
      await expect(figure.locator('pre')).toBeHidden();
      await figure.locator('summary').click();
      await expect(figure.locator('pre')).toBeVisible();
      await expect(figure.locator('pre')).not.toHaveText('');
      await figure.locator('summary').click();
    }
  }
});

test('narrow concepts illustrations scroll within a keyboard-accessible region', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/zh-CN/concepts.html');
  const region = page.locator('[data-concept-diagram="overview"] .diagram-viewport');
  expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await region.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('localized SVG labels stay inside the canvas and their state or operation boxes', async ({ page, request }) => {
  for (const id of expected) {
    const response = await request.get(`/assets/zh-CN/${asset(id)}`);
    expect(response.ok()).toBe(true);
    await page.setContent(await response.text());
    const problems = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      const box = svg.viewBox.baseVal;
      const errors = [];
      for (const text of svg.querySelectorAll('text')) {
        const b = text.getBBox();
        if (b.x < 0 || b.y < 0 || b.x + b.width > box.width || b.y + b.height > box.height) errors.push(`canvas: ${text.textContent}`);
        if (parseFloat(getComputedStyle(text).fontSize) < 14) errors.push(`font: ${text.textContent}`);
        const group = text.closest('[data-node], [data-state]');
        const rectangle = group?.querySelector(':scope > rect');
        if (rectangle) {
          const r = rectangle.getBBox();
          if (b.x < r.x || b.y < r.y || b.x + b.width > r.x + r.width || b.y + b.height > r.y + r.height) errors.push(`node: ${text.textContent}`);
        }
      }
      return errors;
    });
    expect(problems, id).toEqual([]);
  }
});

test('Chinese homepage has Chinese state labels and the Chinese no-script figure', async ({ browser, page, baseURL }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('/zh-CN/#demo');
  await expect(page.locator('[data-demo]')).toHaveAttribute('data-step', '3', { timeout: 8_000 });
  await expect(page.locator('[data-demo-value="audit-state"]')).toContainText('已锁定（locked）');
  await expect(page.locator('[data-demo]')).toHaveAttribute('data-step', '4');
  await expect(page.locator('[data-demo-value="fulfillment-state"]')).toContainText('待调度（scheduled）');
  await page.setViewportSize({ width: 860, height: 900 });
  const labels = await page.locator('.demo-edge > span').evaluateAll((items) => items.map((item) => {
    const label = item.getBoundingClientRect(), edge = item.parentElement.getBoundingClientRect();
    return { lines: item.textContent.split('\n').length, aboveArrow: label.bottom < edge.y + edge.height / 2, insideSlot: label.width <= edge.width };
  }));
  expect(labels).toHaveLength(3);
  expect(labels.every(({ lines, aboveArrow, insideSlot }) => lines === 2 && aboveArrow && insideSlot)).toBe(true);
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const fallback = await context.newPage();
    await fallback.goto('/zh-CN/#demo');
    const image = fallback.locator('noscript img');
    await expect(image).toBeVisible();
    expect(await image.evaluate((img) => new URL(img.src).pathname)).toBe('/assets/zh-CN/fig-overview.svg');
    expect(await image.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  } finally { await context.close(); }
});

test('SVGs and their source text work without JavaScript and without a remote rendering service', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const requests = [];
    page.on('request', (request) => requests.push({ url: request.url(), type: request.resourceType() }));
    await page.goto('/zh-CN/concepts.html');
    for (const id of expected) {
      const figure = page.locator(`[data-concept-diagram="${id}"]`);
      await expect(figure.locator('img')).toBeVisible();
      await figure.locator('summary').click();
      await expect(figure.locator('pre')).toBeVisible();
    }
    const origin = new URL(page.url()).origin;
    expect(requests.filter(({ url }) => new URL(url).origin !== origin)).toEqual([]);
    expect(requests.filter(({ type }) => ['xhr', 'fetch', 'font'].includes(type))).toEqual([]);
    expect(requests.filter(({ url }) => /\/assets\/zh-CN\/(?:fig-overview|concepts-(?:lifecycle|filter))\.svg$/.test(url))).toHaveLength(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { await context.close(); }
});

test('all five explanatory figures have paired readable presentations and original sources without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 320, height: 900 } });
  try {
    const page = await context.newPage();
    for (const [file, id] of [['concepts', 'creation'], ['observability-cloud', 'monitoring'], ['benchmark', 'capacity'], ['turso', 'validation'], ['operations', 'shutdown-budget']]) {
      let englishSource;
      for (const locale of ['', 'zh-CN/']) {
        await page.goto(`/${locale}${file}.html`);
        const figure = page.locator(`[data-explanatory-figure="${id}"]`);
        await expect(figure.locator('.explanatory-viewport')).toBeVisible();
        if (locale) await expect(figure.locator('.explanatory-viewport')).toContainText(/[\u3400-\u9fff]/);
        if (id === 'creation') expect(await figure.locator('table').evaluate((table) => table.getBoundingClientRect().height)).toBeLessThan(450);
        await expect(figure.locator('pre')).toBeHidden();
        await figure.locator('summary').click();
        await expect(figure.locator('pre')).toBeVisible();
        const source = await figure.locator('pre').textContent();
        if (locale) expect(source).toBe(englishSource);
        else englishSource = source;
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      }
    }
  } finally { await context.close(); }
});
