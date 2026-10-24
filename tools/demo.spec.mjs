import { test, expect } from '@playwright/test';

async function expectNoHorizontalOverflow(page) {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
}

test('desktop demo plays once and supports keyboard pause and replay', async ({ page }) => {
  const browserErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('/#demo');

  const demo = page.locator('[data-demo]');
  const toggle = page.locator('[data-demo-toggle]');
  const replay = page.locator('[data-demo-replay]');
  await expect(demo).toBeVisible();
  await expect(page.locator('[data-demo-step]')).toHaveCount(8);
  await expect(demo).toContainText('topic stores nothing');
  await expect(demo).toContainText('same message ID, different sequence numbers');
  await expect(demo).toContainText('Delivery is at-least-once');

  await expect.poll(async () => Number(await demo.getAttribute('data-step'))).toBeGreaterThan(0);
  await expect(toggle).toHaveText('pause animation');
  await expect.poll(() => page.locator('.demo-edge.is-hot').first().evaluate((element) => (
    getComputedStyle(element, '::before').animationName
  ))).toBe('demo-edge-flow');
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveText('resume animation');
  await expect.poll(() => page.locator('.demo-edge.is-hot').first().evaluate((element) => (
    getComputedStyle(element, '::before').animationName
  ))).toBe('none');
  const pausedAt = await demo.getAttribute('data-step');
  await page.waitForTimeout(1700);
  await expect(demo).toHaveAttribute('data-step', pausedAt);

  await page.keyboard.press('Space');
  await expect(toggle).toHaveText('pause animation');
  await expect.poll(async () => await demo.getAttribute('data-step')).not.toBe(pausedAt);
  await replay.click();
  await expect(demo).toHaveAttribute('data-step', '0');
  await expectNoHorizontalOverflow(page);
  expect(browserErrors).toEqual([]);
});

test('reduced motion shows the complete static contract without autoplay', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#demo');

  const demo = page.locator('[data-demo]');
  await expect(demo).toHaveAttribute('data-motion', 'reduced');
  await expect(demo).toHaveAttribute('data-step', '7');
  await expect(demo).toHaveAttribute('data-playing', 'false');
  await expect(page.locator('[data-demo-toggle]')).toBeDisabled();
  await expect(page.locator('[data-demo-replay]')).toBeDisabled();
  await page.waitForTimeout(1300);
  await expect(demo).toHaveAttribute('data-step', '7');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
});

test('changing the operating-system motion preference stops an active demo', async ({ page }) => {
  await page.goto('/#demo');
  const demo = page.locator('[data-demo]');
  await expect(demo).toHaveAttribute('data-playing', 'true');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(demo).toHaveAttribute('data-motion', 'reduced');
  await expect(demo).toHaveAttribute('data-step', '7');
  await expect(demo).toHaveAttribute('data-playing', 'false');
  await expect(page.locator('[data-demo-toggle]')).toBeDisabled();
  await expect(page.locator('[data-demo-replay]')).toBeDisabled();

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(demo).not.toHaveAttribute('data-motion', 'reduced');
  await expect(page.locator('[data-demo-toggle]')).toBeEnabled();
  await expect(page.locator('[data-demo-replay]')).toBeEnabled();
  await expect(demo).toHaveAttribute('data-playing', 'true');
});

test('tablet and mobile use the vertical transcript without horizontal overflow', async ({ page }) => {
  for (const viewport of [{ width: 768, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/#demo');

    await expect(page.locator('[data-demo-controls]')).toBeVisible();
    await expect(page.locator('.demo-visual')).toBeHidden();
    await expect(page.locator('[data-demo-step]')).toHaveCount(8);
    await expect(page.locator('[data-demo-step="7"]')).toBeVisible();
    const captionHeight = await page.locator('.demo-caption').evaluate((element) => element.getBoundingClientRect().height);
    if (viewport.width === 390) {
      await expect(page.locator('[data-demo]')).toHaveAttribute('data-step', '4', { timeout: 8_000 });
      await expect.poll(() => page.locator('.demo-caption').evaluate((element) => element.getBoundingClientRect().height)).toBe(captionHeight);
    }
    await expectNoHorizontalOverflow(page);
  }
});

test('short landscape viewports can autoplay and explicitly resume', async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 320 });
  await page.goto('/#demo');

  const demo = page.locator('[data-demo]');
  const toggle = page.locator('[data-demo-toggle]');
  await expect(page.locator('.demo-visual')).toBeHidden();
  await expect.poll(async () => Number(await demo.getAttribute('data-step'))).toBeGreaterThan(0);
  await toggle.click();
  await expect(toggle).toHaveText('resume animation');
  const pausedAt = await demo.getAttribute('data-step');
  await toggle.click();
  await expect.poll(async () => await demo.getAttribute('data-step')).not.toBe(pausedAt);
  await expectNoHorizontalOverflow(page);
});

test('offscreen playback pauses and resumes without advancing in the background', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto('/#demo');
  const demo = page.locator('[data-demo]');
  await expect.poll(async () => Number(await demo.getAttribute('data-step'))).toBeGreaterThan(0);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(demo).toHaveAttribute('data-visible', 'false');
  const pausedAt = await demo.getAttribute('data-step');
  await page.waitForTimeout(1700);
  await expect(demo).toHaveAttribute('data-step', pausedAt);

  await demo.scrollIntoViewIfNeeded();
  await expect(demo).toHaveAttribute('data-visible', 'true');
  await expect.poll(async () => await demo.getAttribute('data-step')).not.toBe(pausedAt);
});

test('one-shot playback reaches a stable final state with no running animation', async ({ page }) => {
  test.setTimeout(20_000);
  await page.goto('/#demo');
  const demo = page.locator('[data-demo]');

  await expect(demo).toHaveAttribute('data-step', '7', { timeout: 12_000 });
  await expect(demo).toHaveAttribute('data-playing', 'false');
  await expect(page.locator('[data-demo-toggle]')).toHaveText('play again');
  await expect.poll(() => page.locator('.demo-edge').first().evaluate((element) => (
    getComputedStyle(element, '::before').animationName
  ))).toBe('none');
  await page.waitForTimeout(1500);
  await expect(demo).toHaveAttribute('data-step', '7');
});

test('the no-JavaScript page keeps a readable transcript and static figure', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('/#demo');

  await expect(page.locator('[data-demo-controls]')).toBeHidden();
  await expect(page.locator('.demo-visual')).toBeHidden();
  await expect(page.locator('[data-demo-step]')).toHaveCount(8);
  await expect(page.locator('noscript figure.fig')).toBeVisible();
  await expect(page.locator('[data-demo]')).toContainText('handlers must remain idempotent');
  await expectNoHorizontalOverflow(page);
  await context.close();
});

test('reference pages do not load landing-demo assets', async ({ page }) => {
  await page.goto('/concepts.html');
  await expect(page.locator('link[href="assets/demo.css"]')).toHaveCount(0);
  await expect(page.locator('script[src="assets/demo.js"]')).toHaveCount(0);
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name));
  expect(resources.some((url) => /\/demo\.(?:css|js)$/.test(url))).toBe(false);
});
