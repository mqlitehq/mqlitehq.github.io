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
      if (row === header) expect(order).toEqual(['Concepts', 'For AI agents', 'Internals', 'API', 'CLI', 'Access keys', 'Deployment', 'Observability', 'Cloud monitoring', 'Operations', 'GitHub ↗']);
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
  // The narrower header popup can cover the title's center; its left corner
  // remains outside the popup and exercises a real, unobstructed pointer click.
  await page.locator('.hero h1').click({ position: { x: 8, y: 8 } });
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
  await expect(row.locator('.overflow-more > summary')).toHaveAttribute('aria-label', 'More navigation links');
  await expect(row.locator('.overflow-more')).toBeHidden();
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(row.locator('.overflow-more')).toBeVisible();
  await expect(row.locator('.overflow-more > summary')).toHaveAccessibleName('More navigation links');
});

test('all links return when space allows and focus leaves a disappearing More safely', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  const row = page.getByRole('navigation', { name: 'Main navigation' });
  await row.locator('.overflow-more > summary').focus();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(row.locator('.overflow-primary > a')).toHaveCount(11);
  await expect(row.locator('.overflow-more')).toBeHidden();
  await expect(row.getByRole('link', { name: 'GitHub', exact: false })).toBeFocused();
  await expectSingleRow(row.locator('.wrap'));
});

test('header uses the available width with the agent entry near the brand and language last', async ({ page }) => {
  for (const locale of ['', 'zh-CN/']) {
    for (const file of ['index.html', 'agents.html', 'api.html']) {
      await page.goto(`/${locale}${file}`);
      const header = page.locator('nav.top');
      const row = header.locator('.links');
      const utilities = header.locator('.nav-utilities');
      await expect(utilities.locator('[data-language-picker]')).toHaveCount(1);
      await expect(row.locator('[data-language-picker]')).toHaveCount(0);
      for (const width of [768, 1024, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        const agent = row.locator('.overflow-primary > a[href="agents.html"]');
        await expect(agent).toBeVisible();
        const geometry = await header.evaluate((nav) => {
          const brand = nav.querySelector('.brand').getBoundingClientRect();
          const first = nav.querySelector('.overflow-primary > a').getBoundingClientRect();
          const links = nav.querySelector('.links').getBoundingClientRect();
          const utility = nav.querySelector('.nav-utilities');
          const box = utility.getBoundingClientRect();
          return { startGap: first.left - brand.right, utilityGap: box.left - links.right,
            rightInset: innerWidth - box.right, divider: parseFloat(getComputedStyle(utility).borderLeftWidth),
            lastControl: utility.parentElement.lastElementChild === utility };
        });
        expect(geometry.startGap).toBeGreaterThanOrEqual(12);
        expect(geometry.startGap).toBeLessThanOrEqual(24);
        expect(geometry.utilityGap).toBeGreaterThan(0);
        expect(geometry.rightInset).toBeGreaterThanOrEqual(16);
        expect(geometry.rightInset).toBeLessThanOrEqual(24);
        expect(geometry.divider).toBe(1);
        expect(geometry.lastControl).toBe(true);
        await expectSingleRow(header.locator('.wrap'));
        await expectNoPageOverflow(page);
        if (width >= 1440) {
          await expect(row.locator('.overflow-primary > a')).toHaveCount(11);
          await expect(row.locator('.overflow-more')).toBeHidden();
        }
      }
    }
  }
});

test('the homepage shows only the latest release badge in both languages', async ({ page }, testInfo) => {
  const metadata = await (await page.request.get('/site-metadata.json')).json();
  for (const locale of ['', 'zh-CN/']) {
    for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`/${locale}index.html`);
      const hero = page.locator('.hero');
      const badge = hero.locator('.chip.v');
      await expect(badge).toHaveCount(1);
      await expect(badge).toHaveText(`${locale ? '最新版本' : 'Latest release'} ${metadata.latestRelease}`);
      await expect(badge).toHaveAttribute('href', `https://github.com/mqlitehq/mqlite/releases/tag/${metadata.latestRelease}`);
      await expect(hero).not.toContainText(/\bmain\b|\bsource\b|unreleased|withdrawn|retracted|unsupported|未发布|撤回|撤销|不再受支持|源码|源版本/i);
      await expectNoPageOverflow(page);
      const name = `homepage-${locale ? 'zh' : 'en'}-${label}`;
      const screenshot = testInfo.outputPath(name + '.png');
      await page.screenshot({ path: screenshot, fullPage: false });
      await testInfo.attach(name, { path: screenshot, contentType: 'image/png' });
    }
  }
});

test('capture the reviewed header at desktop, compact, mobile and zoomed widths', async ({ page }, testInfo) => {
  for (const locale of ['', 'zh-CN/']) {
    for (const scenario of [
      { label: 'desktop', width: 1440, height: 760, zoom: '1' },
      { label: 'compact', width: 1024, height: 760, zoom: '1' },
      { label: 'mobile', width: 390, height: 844, zoom: '1' },
      { label: 'zoom200', width: 1280, height: 900, zoom: '2' },
    ]) {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.goto(`/${locale}agents.html`);
      await page.evaluate((zoom) => { document.documentElement.style.zoom = zoom; }, scenario.zoom);
      const header = page.locator('nav.top');
      await expectSingleRow(header.locator('.wrap'));
      await expect(header.locator('.nav-utilities [data-language-picker] > summary')).toBeVisible();
      if (scenario.label !== 'mobile') await expect(header.locator('.overflow-primary > a[href="agents.html"]')).toBeVisible();
      await expectNoPageOverflow(page);
      const name = `navigation-${locale ? 'zh' : 'en'}-${scenario.label}`;
      const screenshot = testInfo.outputPath(name + '.png');
      await page.screenshot({ path: screenshot, fullPage: false });
      await testInfo.attach(name, { path: screenshot, contentType: 'image/png' });
    }
  }
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
  const row = page.getByRole('navigation', { name: 'Main navigation' });
  const tail = row.getByRole('link', { name: 'GitHub ↗', exact: true });
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
