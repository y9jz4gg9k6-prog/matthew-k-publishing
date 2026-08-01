const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'test-results', 'screenshots');
const pages = [
  { path: '/index.html', slug: 'homepage', mockups: 6 },
  { path: '/books.html', slug: 'books', mockups: 3 },
  { path: '/book-unshakable.html', slug: 'unshakable', mockups: 1 },
  { path: '/book-beginners.html', slug: 'beginners', mockups: 1 },
  { path: '/book-experts.html', slug: 'experts', mockups: 1 },
  { path: '/about.html', slug: 'about', mockups: 0 },
  { path: '/publishing.html', slug: 'publishing', mockups: 0 },
  { path: '/press.html', slug: 'press', mockups: 0 },
  { path: '/resources.html', slug: 'resources', mockups: 0 },
  { path: '/contact.html', slug: 'contact', mockups: 0 }
];
const layouts = [
  { name: 'desktop', viewport: { width: 1672, height: 941 }, isMobile: false },
  { name: 'mobile', viewport: { width: 430, height: 932 }, isMobile: true }
];
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

function resolveRequestPath(url) {
  let pathname = decodeURIComponent(new URL(url, 'http://127.0.0.1').pathname);
  if (pathname === '/') pathname = '/index.html';
  if (!path.extname(pathname)) pathname += '.html';
  const resolved = path.resolve(root, `.${pathname}`);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function startServer() {
  const server = http.createServer((request, response) => {
    const filePath = resolveRequestPath(request.url);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const headers = {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filePath).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function assertInternalLinks(page, baseURL) {
  const hrefs = await page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href')));
  const local = [...new Set(hrefs.filter(Boolean).filter(href => !/^(?:https?:|mailto:|tel:|#)/i.test(href)))];
  for (const href of local) {
    const url = new URL(href, page.url());
    const response = await page.request.fetch(url.toString(), { method: 'HEAD' });
    assert.equal(response.status(), 200, `Broken internal link ${href} on ${page.url()}`);
    assert.equal(url.origin, baseURL, `Internal link escaped local origin: ${href}`);
  }
}

async function assertImages(page) {
  const images = await page.locator('img').evaluateAll(nodes => nodes.map(image => ({
    src: image.currentSrc || image.src,
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight
  })));
  assert.ok(images.length > 0, `No images found on ${page.url()}`);
  for (const image of images) {
    assert.ok(image.complete, `Image did not finish loading: ${image.src}`);
    assert.ok(image.naturalWidth > 0 && image.naturalHeight > 0, `Missing or invalid image: ${image.src}`);
  }
}

async function assertMockups(page, expectedCount, pageSlug) {
  if (pageSlug === 'homepage') {
    const section = page.locator('.reference:visible');
    const markers = section.locator('[data-mockup-group]');
    assert.equal(await markers.count(), expectedCount, 'Homepage must expose all six approved mockup groups');
    const data = await markers.evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect();
      const parent = node.parentElement.getBoundingClientRect();
      return {
        devices: node.dataset.devices,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, height: rect.height },
        parent: { left: parent.left, top: parent.top, right: parent.right, bottom: parent.bottom }
      };
    }));
    for (const group of data) {
      assert.equal(group.devices, 'hardcover ipad iphone', 'Each mockup group must identify one hardcover, one iPad, and one iPhone');
      assert.ok(group.rect.left >= group.parent.left && group.rect.top >= group.parent.top, 'Mockup group starts outside the approved image');
      assert.ok(group.rect.right <= group.parent.right + 0.5 && group.rect.bottom <= group.parent.bottom + 0.5, 'Mockup group is clipped by the approved image');
    }
    const mainHeights = data.slice(0, 3).map(group => group.rect.height);
    assert.ok(Math.max(...mainHeights) - Math.min(...mainHeights) < 1, 'Main-stage mockup groups must use matching heights');
    return;
  }

  const mockups = page.locator('.mockup-box img, .detail-visual img');
  assert.equal(await mockups.count(), expectedCount, `Unexpected mockup count on ${pageSlug}`);
  const geometry = await mockups.evaluateAll(nodes => nodes.map(image => {
    const rect = image.getBoundingClientRect();
    const box = image.parentElement.getBoundingClientRect();
    const style = getComputedStyle(image);
    return {
      alt: image.alt,
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      fit: style.objectFit,
      transform: style.transform,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
    };
  }));
  for (const mockup of geometry) {
    assert.ok(mockup.complete && mockup.naturalWidth > 0 && mockup.naturalHeight > 0, `Mockup source is incomplete: ${mockup.alt}`);
    assert.match(mockup.alt, /hardcover, iPad and iPhone/i, `Mockup alt text must identify all three devices: ${mockup.alt}`);
    assert.equal(mockup.fit, 'contain', `Mockup must use object-fit: contain: ${mockup.alt}`);
    assert.equal(mockup.transform, 'none', `Mockup must not be stretched or transformed: ${mockup.alt}`);
    assert.ok(mockup.rect.left >= mockup.box.left - 0.5 && mockup.rect.top >= mockup.box.top - 0.5, `Mockup starts outside its visual box: ${mockup.alt}`);
    assert.ok(mockup.rect.right <= mockup.box.right + 0.5 && mockup.rect.bottom <= mockup.box.bottom + 0.5, `Mockup is clipped: ${mockup.alt}`);
  }
}

async function assertNavigation(page, pageSlug, layoutName) {
  const button = pageSlug === 'homepage'
    ? page.locator(`.${layoutName}-ref [data-menu-button]`)
    : page.locator('[data-menu-button="secondaryMenu"]');
  await button.click();
  const panel = pageSlug === 'homepage'
    ? page.locator(`.${layoutName}-ref .menu-panel`)
    : page.locator('#secondaryMenu');
  await panel.waitFor({ state: 'visible' });
  assert.ok(await panel.locator('a[href="books.html"]').isVisible(), 'Responsive navigation did not expose Books');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
}

async function assertForm(page, pageSlug, layoutName) {
  if (pageSlug === 'homepage') {
    const form = page.locator(`.${layoutName}-ref form[data-email-form]`);
    await form.locator('input[type="email"]').fill('qa@example.com');
    await form.locator('button[type="submit"]').click();
    await form.locator('.form-status').filter({ hasText: 'successfully' }).waitFor();
  }
  if (pageSlug === 'contact') {
    const form = page.locator('form[data-email-form]');
    await form.locator('#name').fill('Chromium QA');
    await form.locator('#email').fill('qa@example.com');
    await form.locator('#message').fill('Responsive form verification.');
    await form.locator('button[type="submit"]').click();
    await form.locator('.form-status').filter({ hasText: 'successfully' }).waitFor();
  }
}

async function run() {
  fs.mkdirSync(outputDir, { recursive: true });
  const requestedPages = new Set((process.env.TEST_PAGES || '').split(',').filter(Boolean));
  const requestedLayout = process.env.TEST_LAYOUT || '';
  const activePages = requestedPages.size ? pages.filter(entry => requestedPages.has(entry.slug)) : pages;
  const activeLayouts = requestedLayout ? layouts.filter(layout => layout.name === requestedLayout) : layouts;
  assert.ok(activePages.length > 0, 'TEST_PAGES did not match any configured page slugs');
  assert.ok(activeLayouts.length > 0, 'TEST_LAYOUT must be desktop or mobile');
  const server = await startServer();
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}`;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const results = [];
  const failures = [];

  try {
    for (const layout of activeLayouts) {
      for (const entry of activePages) {
        const label = `${entry.slug}-${layout.name}`;
        const browser = await chromium.launch({ headless: true, executablePath });
        let context;
        try {
          context = await browser.newContext({ viewport: layout.viewport, deviceScaleFactor: 1, isMobile: layout.isMobile });
          const page = await context.newPage();
          const consoleErrors = [];
          const runtimeErrors = [];
          const badResponses = [];
          page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
          page.on('pageerror', error => runtimeErrors.push(error.message));
          page.on('response', response => {
            if (response.url().startsWith(baseURL) && response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
          });
          await page.route('https://formsubmit.co/**', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true })
          }));

          try {
            const response = await page.goto(`${baseURL}${entry.path}`, { waitUntil: 'networkidle' });
            assert.equal(response.status(), 200, `${label} did not load successfully`);
            await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            assert.ok(overflow <= 0, `${label} has ${overflow}px of horizontal overflow`);
            await assertInternalLinks(page, baseURL);
            await assertImages(page);
            await assertMockups(page, entry.mockups, entry.slug);

            const screenshot = path.join(outputDir, `${label}.png`);
            await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
            await assertNavigation(page, entry.slug, layout.name);
            await assertForm(page, entry.slug, layout.name);

            assert.deepEqual(badResponses, [], `${label} loaded failing local resources`);
            assert.deepEqual(runtimeErrors, [], `${label} raised browser runtime errors`);
            assert.deepEqual(consoleErrors, [], `${label} logged browser console errors`);
            results.push({ label, status: 'passed', screenshot: path.relative(root, screenshot), overflow });
            process.stdout.write(`PASS ${label}\n`);
          } catch (error) {
            failures.push({ label, error: error.stack || error.message });
            results.push({ label, status: 'failed', error: error.message });
            process.stderr.write(`FAIL ${label}: ${error.message}\n`);
          }
        } finally {
          if (context) await context.close().catch(() => {});
          await browser.close().catch(() => {});
        }
      }
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  const reportDir = path.join(root, 'test-results');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportName = process.env.TEST_REPORT || 'report.json';
  fs.writeFileSync(path.join(reportDir, reportName), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) {
    process.stderr.write(`\n${failures.length} Chromium scenario(s) failed.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`\nAll ${results.length} Chromium scenarios passed.\n`);
  }
}

run().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
