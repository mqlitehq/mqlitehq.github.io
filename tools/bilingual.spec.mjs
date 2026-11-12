import { test, expect } from '@playwright/test';

const documents = [
  'concepts', 'internals', 'api', 'cli', 'access-keys', 'deployment',
  'observability', 'observability-cloud', 'operations', 'turso', 'retention',
  'benchmark', 'conformance', 'dependencies', 'mcp', 'examples',
];

async function expectNoHorizontalOverflow(page) {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  ))).toBe(true);
}

async function expectSingleRow(row) {
  await expect.poll(() => row.evaluate((element) => {
    const controls = Array.from(element.querySelectorAll('a, summary')).filter((item) => (
      item.getClientRects().length && !item.closest('.overflow-items, .language-options')
    ));
    const centers = controls.map((item) => {
      const box = item.getBoundingClientRect();
      return box.y + box.height / 2;
    });
    return element.scrollWidth <= element.clientWidth + 1
      && centers.length > 0 && Math.max(...centers) - Math.min(...centers) < 2;
  })).toBe(true);
}

async function expectPanelInsideViewport(page, row) {
  const summary = row.locator('.overflow-more > summary');
  await expect(summary).toBeVisible();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(row.locator('.overflow-more')).toHaveAttribute('open', '');
  const panel = await row.locator('.overflow-items').boundingBox();
  expect(panel).not.toBeNull();
  expect(panel.x).toBeGreaterThanOrEqual(-1);
  expect(panel.x + panel.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  await page.keyboard.press('Tab');
  await expect(row.locator('.overflow-items > a').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row.locator('.overflow-more')).not.toHaveAttribute('open');
  await expect(summary).toBeFocused();
}

async function expectLanguagePanelInsideViewport(page) {
  const picker = page.locator('[data-language-picker]');
  const summary = picker.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(picker).toHaveAttribute('open', '');
  const panel = await picker.locator('.language-options').boundingBox();
  expect(panel).not.toBeNull();
  expect(panel.x).toBeGreaterThanOrEqual(-1);
  expect(panel.x + panel.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  await expectSingleRow(page.locator('nav.top .wrap'));
  await page.keyboard.press('Tab');
  await expect(picker.locator('[data-language-switch]').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).not.toHaveAttribute('open');
  await expect(summary).toBeFocused();
}

test('English remains the default even when the browser prefers Simplified Chinese', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN' });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('.hero .tag')).toContainText('A message queue');
    await expect(page.locator('[data-language-picker] > summary')).toHaveAccessibleName('Language: English');
    await expect(page.locator('[data-language-switch]')).toHaveText(['English', '简体中文']);
    await expect(page.locator('[data-language-switch][hreflang="en"]')).toHaveAttribute('aria-current', 'true');
    await page.goto('/zh-CN/index.html');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('[data-language-picker] > summary')).toHaveAccessibleName('语言：简体中文');
    await expect(page.locator('[data-language-switch][hreflang="zh-CN"]')).toHaveAttribute('aria-current', 'true');
    // A prior explicit visit must not turn an English URL into an automatic redirect.
    await page.goto('/api.html');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(new URL(page.url()).pathname).toBe('/api.html');
  } finally {
    await context.close();
  }
});

test('language switch preserves the current document, query and section in both directions', async ({ page }) => {
  await page.goto('/api.html?view=contract&example=receive#auth');
  const picker = page.locator('[data-language-picker]');
  const english = picker.locator('[data-language-switch][hreflang="en"]');
  const chinese = picker.locator('[data-language-switch][hreflang="zh-CN"]');
  await expect(english).toHaveAttribute('href', /\/api\.html\?view=contract&example=receive#auth$/);
  await expect(chinese).toHaveAttribute('href', /\/zh-CN\/api\.html\?view=contract&example=receive#auth$/);
  await picker.locator('summary').click();
  await chinese.click();
  await expect(page).toHaveURL(/\/zh-CN\/api\.html\?view=contract&example=receive#auth$/);
  await expect(page.locator('#auth')).toBeVisible();
  await expect(chinese).toHaveAttribute('aria-current', 'true');
  await expect(english).not.toHaveAttribute('aria-current');
  await picker.locator('summary').click();
  await english.click();
  await expect(page).toHaveURL(/\/api\.html\?view=contract&example=receive#auth$/);
  // Anchors selected after document load must be kept as well.
  await page.evaluate(() => { location.hash = 'errors'; });
  await expect(english).toHaveAttribute('href', /\/api\.html\?view=contract&example=receive#errors$/);
  await expect(chinese).toHaveAttribute('href', /\/zh-CN\/api\.html\?view=contract&example=receive#errors$/);
  await picker.locator('summary').click();
  await chinese.click();
  await expect(page).toHaveURL(/\/zh-CN\/api\.html\?view=contract&example=receive#errors$/);
});

test('the language picker supports keyboard selection, dismissal and exclusive navigation panels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const picker = page.locator('[data-language-picker]');
  const summary = picker.locator('summary');
  const options = picker.locator('[data-language-switch]');
  const more = page.locator('nav.top .overflow-more');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(picker).toHaveAttribute('open', '');
  await page.keyboard.press('Tab');
  await expect(options.nth(0)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(options.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).not.toHaveAttribute('open');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Space');
  await expect(picker).toHaveAttribute('open', '');
  await more.locator('summary').click();
  await expect(more).toHaveAttribute('open', '');
  await expect(picker).not.toHaveAttribute('open');
  await summary.click();
  await expect(picker).toHaveAttribute('open', '');
  await expect(more).not.toHaveAttribute('open');
  await page.locator('.hero h1').click();
  await expect(picker).not.toHaveAttribute('open');
  await summary.click();
  await page.locator('nav.top .brand').focus();
  await expect(picker).not.toHaveAttribute('open');
  await summary.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/zh-CN\/index\.html$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

test('an additional language link receives location preservation and native keyboard access', async ({ page }) => {
  // Add a catalog entry before site.js runs; this tests extension without a fake translated page.
  await page.route(/\/agents\.html(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    expect(html).toMatch(/<a\b[^>]*data-language-switch/);
    const body = html.replace(/(?=<a\b[^>]*data-language-switch)/,
      '<a data-language-switch href="fr/agents.html" hreflang="fr" lang="fr">Français</a>');
    await route.fulfill({ response, body });
  });
  await page.goto('/agents.html?view=extended#p1');
  const picker = page.locator('[data-language-picker]');
  const french = picker.locator('[data-language-switch][hreflang="fr"]');
  await expect(french).toHaveAttribute('href', /\/fr\/agents\.html\?view=extended#p1$/);
  await page.evaluate(() => { location.hash = 'rules'; });
  await expect(french).toHaveAttribute('href', /\/fr\/agents\.html\?view=extended#rules$/);
  await picker.locator('summary').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(french).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).not.toHaveAttribute('open');
  await expect(picker.locator('summary')).toBeFocused();
});

test('Chinese navigation stays on one line at 320px and at 200 percent zoom', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/zh-CN/index.html');
  for (const scenario of [
    { width: 320, height: 844, zoom: '1' },
    { width: 1280, height: 900, zoom: '2' },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.evaluate((zoom) => { document.documentElement.style.zoom = zoom; }, scenario.zoom);
    const header = page.locator('nav.top');
    const hero = page.locator('nav.cta');
    await expectSingleRow(header.locator('.wrap'));
    await expectSingleRow(hero);
    await expect(page.locator('[data-language-picker] > summary')).toBeVisible();
    await expectLanguagePanelInsideViewport(page);
    await expectPanelInsideViewport(page, header);
    await expectPanelInsideViewport(page, hero);
    await expectNoHorizontalOverflow(page);
    // Moving links into More must neither duplicate nor lose a destination.
    const hrefs = await header.locator('.overflow-primary > a, .overflow-items > a')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect(hrefs).toHaveLength(11);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  }
  expect(errors).toEqual([]);
});

test('every English and Chinese page contains long identifiers at mobile and tablet widths', async ({ page }) => {
  test.setTimeout(90_000);
  for (const file of ['index.html', 'agents.html', ...documents.map((name) => `${name}.html`)]) {
    for (const locale of ['', 'zh-CN/']) {
      await page.goto(`/${locale}${file}`);
      for (const width of [320, 768]) {
        await page.setViewportSize({ width, height: 900 });
        await expectNoHorizontalOverflow(page);
      }
    }
  }
});

test('every document keeps its English heading IDs and literal code examples in Chinese', async ({ page }) => {
  test.setTimeout(90_000);
  for (const name of documents) {
    await page.goto(`/${name}.html`);
    const english = await page.locator('main.prose').evaluate((main) => ({
      headings: Array.from(main.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => [h.tagName, h.id]),
      code: Array.from(main.querySelectorAll('pre > code')).map((code) => code.textContent),
    }));
    await page.goto(`/zh-CN/${name}.html`);
    const chinese = await page.locator('main.prose').evaluate((main) => ({
      headings: Array.from(main.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => [h.tagName, h.id]),
      code: Array.from(main.querySelectorAll('pre > code')).map((code) => code.textContent),
      text: main.textContent,
    }));
    expect(chinese.headings, `${name}: anchor correspondence`).toEqual(english.headings);
    expect(chinese.code, `${name}: code example correspondence`).toEqual(english.code);
    expect(chinese.text, `${name}: translated prose`).toMatch(/[\u3400-\u9fff]/u);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('.stamp')).toContainText('v0.4.2');
  }
});

test('representative protocol pages distinguish settlement, leases, deduplication and commit', async ({ page }) => {
  await page.goto('/zh-CN/api.html');
  const api = page.locator('main.prose');
  for (const term of ['结算', '租约', '去重', '提交', '截止时间', '未知结果']) {
    await expect(api).toContainText(term);
  }
  await expect(api).toContainText('Complete');
  await expect(api).toContainText('ErrOutcomeUnknown');
  await expect(api).toContainText('Retry-After');
  await page.goto('/zh-CN/access-keys.html');
  await expect(page.locator('main.prose')).toContainText('公开 ID');
  await expect(page.locator('main.prose')).toContainText('秘密值');
  await page.goto('/zh-CN/turso.html');
  await expect(page.locator('main.prose')).toContainText('Turso');
  await expect(page.locator('main.prose')).toContainText('outcome_unknown');
});

test('the Chinese agent instructions copy Chinese prose with unchanged protocol literals', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.copiedPrompt = text; } } });
  });
  await page.goto('/zh-CN/agents.html');
  const prompt = page.locator('#p1 > code');
  await expect(prompt).toContainText('你可以访问一个消息队列');
  await expect(prompt).toContainText('不要重试删除');
  await expect(prompt).toContainText('<MQLITE_ENDPOINT>');
  await expect(prompt).toContainText('QueueService/Complete {"queue":"jobs","seq_number":N,"lock_token":"..."}');
  await page.locator('#p1').locator('..').getByRole('button', { name: '复制', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.copiedPrompt)).toBe((await prompt.textContent()).replace(/\n$/, ''));
});

test('language selection and the Chinese More menu remain usable without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 320, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto('/operations.html');
    const picker = page.locator('[data-language-picker]');
    await picker.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(picker.locator('[data-language-switch]')).toHaveText(['English', '简体中文']);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/zh-CN\/operations\.html$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    const nav = page.locator('nav.top');
    await expectSingleRow(nav.locator('.wrap'));
    await nav.locator('.overflow-more > summary').click();
    await expect(nav.locator('.overflow-items > a').last()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await nav.locator('.overflow-more > summary').click();
    await picker.locator('summary').focus();
    await page.keyboard.press('Space');
    await picker.locator('[data-language-switch][hreflang="en"]').click();
    await expect(page).toHaveURL(/\/operations\.html$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  } finally {
    await context.close();
  }
});

test('English and Chinese pages publish reciprocal hreflang and an English x-default', async ({ page }) => {
  test.setTimeout(90_000);
  for (const file of ['index.html', 'agents.html', ...documents.map((name) => `${name}.html`)]) {
    for (const chinese of [false, true]) {
      await page.goto(`/${chinese ? 'zh-CN/' : ''}${file}`);
      const alternates = await page.locator('head link[rel="alternate"][hreflang]').evaluateAll((links) => (
        links.map((link) => [link.hreflang, new URL(link.href).pathname]).sort()
      ));
      expect(alternates, `${chinese ? 'zh-CN/' : ''}${file}`).toEqual([
        ['en', `/${file}`], ['x-default', `/${file}`], ['zh-CN', `/zh-CN/${file}`],
      ]);
      const picker = page.locator('[data-language-picker]');
      await expect(picker).toHaveCount(1);
      await expect(picker.locator('[data-language-switch]')).toHaveText(['English', '简体中文']);
      await expect(picker.locator('[aria-current="true"]')).toHaveAttribute('hreflang', chinese ? 'zh-CN' : 'en');
      await expect(picker.locator('[hreflang="en"]')).toHaveAttribute('lang', 'en');
      await expect(picker.locator('[hreflang="zh-CN"]')).toHaveAttribute('lang', 'zh-CN');
    }
  }
});

test('a Chinese document downloads one locale, shared bounded assets, and no external font', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    const requests = [];
    const bodies = [];
    page.on('request', (request) => requests.push({ url: request.url(), type: request.resourceType() }));
    page.on('response', (response) => bodies.push(response.body().then((body) => body.length)));
    await page.goto('/zh-CN/api.html');
    await page.waitForLoadState('networkidle');
    const origin = new URL(page.url()).origin;
    expect(requests.filter(({ url }) => new URL(url).origin !== origin)).toEqual([]);
    expect(requests.filter(({ type }) => ['font', 'fetch', 'xhr'].includes(type))).toEqual([]);
    expect(requests.filter(({ type }) => type === 'document').map(({ url }) => new URL(url).pathname))
      .toEqual(['/zh-CN/api.html']);
    expect(requests.filter(({ url }) => /i18n\/|manifest\.json|llms(?:-full)?\.txt/.test(url))).toEqual([]);
    const assets = requests.filter(({ type }) => ['script', 'stylesheet'].includes(type))
      .map(({ url }) => new URL(url).pathname).sort();
    expect(assets).toEqual(['/assets/highlight.min.js', '/assets/site.css', '/assets/site.js']);
    expect(requests.length).toBeLessThanOrEqual(8);
    expect((await Promise.all(bodies)).reduce((total, size) => total + size, 0)).toBeLessThan(400_000);
    await expect(page.locator('main.prose')).toHaveCount(1);
    await expect(page.locator('main.prose')).toContainText('结算');
  } finally {
    await context.close();
  }
});
