import { test, expect } from '@playwright/test';

async function expectSingleRow(row) {
  const geometry = await row.evaluate((element) => {
    const controls = Array.from(element.querySelectorAll('a, summary')).filter((item) => (
      item.getClientRects().length && !item.closest('.overflow-items, .language-options')
    ));
    return {
      centers: controls.map((item) => {
        const box = item.getBoundingClientRect();
        return box.y + box.height / 2;
      }),
      overflows: element.scrollWidth > element.clientWidth + 1,
    };
  });
  expect(geometry.overflows).toBe(false);
  expect(Math.max(...geometry.centers) - Math.min(...geometry.centers)).toBeLessThan(2);
}

async function expectNoPageOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('header and hero keep one row and move a stable prefix into More at every width', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const header = page.getByRole('navigation', { name: 'Main navigation' });
  const hero = page.getByRole('navigation', { name: 'Get started' });
  let previousHeader = 0;
  let previousHero = 0;
  await page.goto('/');
  for (const width of [320, 390, 600, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => header.locator('.overflow-primary > a').count()).toBeGreaterThanOrEqual(previousHeader);
    await expect.poll(() => hero.locator('.overflow-primary > a').count()).toBeGreaterThanOrEqual(previousHero);
    await expectSingleRow(header.locator('.wrap'));
    await expectSingleRow(hero);
    await expectNoPageOverflow(page);
    await expect(header.locator('[data-language-picker] > summary')).toBeVisible();
    await expect(hero.getByRole('link', { name: 'Quickstart', exact: true })).toBeVisible();
    previousHeader = await header.locator('.overflow-primary > a').count();
    previousHero = await hero.locator('.overflow-primary > a').count();
    for (const row of [header, hero]) {
      const order = await row.locator('.overflow-primary > a, .overflow-items > a').evaluateAll((links) => links.map((link) => link.textContent));
      expect(new Set(order).size).toBe(order.length);
      if (row === header) expect(order).toEqual(['Concepts', 'Internals', 'API', 'CLI', 'Access keys', 'Deployment', 'Observability', 'Cloud monitoring', 'Operations', 'For AI agents', 'GitHub ↗']);
      else expect(order).toEqual(['Watch one message', 'Read the concepts', 'Production operations', 'Access keys', "I'm an AI agent"]);
    }
  }
  expect(previousHeader).toBeGreaterThan(0);
  expect(previousHero).toBeGreaterThan(0);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => header.locator('.overflow-primary > a').count()).toBe(0);
  await expect.poll(() => hero.locator('.overflow-primary > a').count()).toBe(0);
  expect(errors).toEqual([]);
});

test('More is a native keyboard disclosure with Escape, outside click and focus exit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const row = page.getByRole('navigation', { name: 'Main navigation' });
  const more = row.locator('.overflow-more');
  const summary = more.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(more).toHaveAttribute('open', '');
  await page.keyboard.press('Tab');
  await expect(more.locator('.overflow-items > a').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(more).not.toHaveAttribute('open');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Space');
  await expect(more).toHaveAttribute('open', '');
  await page.locator('.hero h1').click();
  await expect(more).not.toHaveAttribute('open');
  await summary.click();
  await page.getByRole('navigation', { name: 'Get started' }).getByRole('link', { name: 'Quickstart', exact: true }).focus();
  await expect(more).not.toHaveAttribute('open');
});

test('a focused link remains reachable through resize and current page is identified inside More', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/concepts.html');
  const row = page.getByRole('navigation', { name: 'Main navigation' });
  const concepts = row.getByRole('link', { name: 'Concepts', exact: true });
  await concepts.focus();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(row.locator('.overflow-more')).toHaveAttribute('open', '');
  await expect(concepts).toBeFocused();
  await expect(concepts).toHaveAttribute('aria-current', 'page');
  await expect(row.locator('.overflow-more > summary')).toHaveAccessibleName('More navigation links; current page: Concepts');
  await expectNoPageOverflow(page);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => row.locator('.overflow-primary > a[aria-current="page"]').count()).toBe(1);
  await expect(row.locator('.overflow-more > summary')).toHaveAccessibleName('More navigation links');
});

test('all links return when space allows and focus leaves a disappearing More safely', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  const row = page.getByRole('navigation', { name: 'Main navigation' });
  await row.locator('.overflow-more > summary').focus();
  await page.addStyleTag({ content: 'nav.top .wrap { max-width: none; }' });
  await page.setViewportSize({ width: 2000, height: 900 });
  await expect(row.locator('.overflow-primary > a')).toHaveCount(11);
  await expect(row.locator('.overflow-more')).toBeHidden();
  await expect(row.getByRole('link', { name: 'GitHub', exact: false })).toBeFocused();
  await expectSingleRow(row.locator('.wrap'));
});

test('a focused More retains focus while resizing with its disclosure closed or open', async ({ page }) => {
  await page.goto('/');
  for (const open of [false, true]) {
    await page.setViewportSize({ width: 390, height: 844 });
    const more = page.getByRole('navigation', { name: 'Main navigation' }).locator('.overflow-more');
    const summary = more.locator('summary');
    await summary.focus();
    if (open) await page.keyboard.press('Enter');
    await page.setViewportSize({ width: 320, height: 844 });
    await expect(summary).toBeFocused();
    await expect(more).toBeVisible();
    expect(await more.evaluate((element) => element.open)).toBe(open);
    if (open) await page.keyboard.press('Escape');
  }
});

test('a focused tail link is revealed inside a scrollable More after shrinking the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.addStyleTag({ content: 'nav.top .wrap { max-width: none; }' });
  const row = page.getByRole('navigation', { name: 'Main navigation' });
  const tail = row.getByRole('link', { name: 'For AI agents', exact: true });
  await tail.focus();
  await page.setViewportSize({ width: 320, height: 320 });
  await expect(tail).toBeFocused();
  await expect.poll(() => tail.evaluate((element) => {
    const item = element.getBoundingClientRect();
    const panel = element.parentElement.getBoundingClientRect();
    return item.top >= panel.top - 1 && item.bottom <= panel.bottom + 1;
  })).toBe(true);
});

test('200 percent zoom reflows both rows and the open panels within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  // Chromium's CSS zoom scales the real layout, including native details and fonts.
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  for (const name of ['Main navigation', 'Get started']) {
    const row = page.getByRole('navigation', { name });
    await expectSingleRow(name === 'Main navigation' ? row.locator('.wrap') : row);
    await row.locator('.overflow-more > summary').click();
    const box = await row.locator('.overflow-items').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    await page.keyboard.press('Escape');
  }
  await expectNoPageOverflow(page);
});

test('without JavaScript, both single rows expose every secondary link through native More', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 844 } });
  const page = await context.newPage();
  await page.goto('/');
  for (const name of ['Main navigation', 'Get started']) {
    const row = page.getByRole('navigation', { name });
    await expectSingleRow(name === 'Main navigation' ? row.locator('.wrap') : row);
    await row.locator('.overflow-more > summary').click();
    await expect(row.locator('.overflow-items a').last()).toBeVisible();
    await expectNoPageOverflow(page);
    await row.locator('.overflow-more > summary').click();
  }
  await context.close();
});
