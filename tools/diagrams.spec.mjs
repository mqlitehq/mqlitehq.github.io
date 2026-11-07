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
      expect(await image.evaluate((img) => new URL(img.src).pathname)).toBe(`/assets/${asset(id)}`);
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
    expect(requests.filter(({ url }) => /\/assets\/(?:fig-overview|concepts-(?:lifecycle|filter))\.svg$/.test(url))).toHaveLength(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { await context.close(); }
});
