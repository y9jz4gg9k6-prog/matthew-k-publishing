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
  { name: 'desktop', viewport: { width: 1672, height: 941 }, isMobile: false, homepageRef: 'desktop' },
  { name: 'tablet', viewport: { width: 820, height: 1180 }, isMobile: true, homepageRef: 'mobile' },
  { name: 'mobile', viewport: { width: 430, height: 932 }, isMobile: true, homepageRef: 'mobile' }
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

function assertInside(inner, outer, label, tolerance = 0.75) {
  assert.ok(inner.left >= outer.left - tolerance, `${label} crosses the left edge`);
  assert.ok(inner.top >= outer.top - tolerance, `${label} crosses the top edge`);
  assert.ok(inner.right <= outer.right + tolerance, `${label} crosses the right edge`);
  assert.ok(inner.bottom <= outer.bottom + tolerance, `${label} crosses the bottom edge`);
}

async function assertMockups(page, expectedCount, pageSlug) {
  if (pageSlug === 'homepage') {
    const section = page.locator('.reference:visible');
    const markers = section.locator('[data-mockup-group]');
    const markerCount = await markers.count();
    assert.equal(markerCount, expectedCount, 'Homepage must expose all six approved mockup groups');
    const data = [];
    for (let index = 0; index < markerCount; index += 1) {
      const marker = markers.nth(index);
      await marker.scrollIntoViewIfNeeded();
      const group = await marker.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const parent = node.parentElement.getBoundingClientRect();
        return {
          name: node.dataset.mockupGroup,
          devices: node.dataset.devices,
          elements: node.dataset.elements,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          parent: { left: parent.left, top: parent.top, right: parent.right, bottom: parent.bottom },
          viewport: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
        };
      });
      assert.equal(group.devices, 'hardcover ipad iphone', 'Each mockup group must identify one hardcover, one iPad, and one iPhone');
      for (const device of ['hardcover', 'ipad', 'iphone']) assert.ok(group.elements.split(' ').includes(device), `${group.name} is missing ${device} metadata`);
      assertInside(group.rect, group.parent, `${group.name} within approved homepage image`);
      assertInside(group.rect, group.viewport, `${group.name} within viewport`);
      assert.ok(group.parent.right - group.rect.right >= 2, `${group.name} has insufficient right-side clearance`);
      data.push(group);
    }
    const mainHeights = data.slice(0, 3).map(group => group.rect.height);
    assert.ok(Math.max(...mainHeights) - Math.min(...mainHeights) < 1, 'Main-stage mockup groups must use matching heights');

    const stages = section.locator('[data-stage-elements]');
    const stageCount = await stages.count();
    assert.equal(stageCount, 1, 'The visible homepage must expose one complete main pedestal/glow/shadow stage');
    const stage = stages.nth(0);
    await stage.scrollIntoViewIfNeeded();
    const stageGeometry = await stage.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const parent = node.parentElement.getBoundingClientRect();
      return {
        elements: node.dataset.stageElements,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        parent: { left: parent.left, top: parent.top, right: parent.right, bottom: parent.bottom },
        viewport: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      };
    });
    for (const effect of ['pedestal', 'glow', 'shadow']) assert.ok(stageGeometry.elements.split(' ').includes(effect), `Homepage stage is missing ${effect} metadata`);
    assertInside(stageGeometry.rect, stageGeometry.parent, 'Homepage pedestal/glow/shadow stage within approved image');
    assertInside(stageGeometry.rect, stageGeometry.viewport, 'Homepage pedestal/glow/shadow stage within viewport');
    return;
  }

  const containers = page.locator('[data-mockup-container]');
  const containerCount = await containers.count();
  assert.equal(containerCount, expectedCount, `Unexpected mockup count on ${pageSlug}`);
  for (let index = 0; index < containerCount; index += 1) {
    const container = containers.nth(index);
    await container.scrollIntoViewIfNeeded();
    const mockup = await container.evaluate(boxNode => {
      const image = boxNode.querySelector('.mockup-image');
      const rect = image.getBoundingClientRect();
      const box = boxNode.getBoundingClientRect();
      const style = getComputedStyle(image);
      const boxStyle = getComputedStyle(boxNode);
      const maxSample = 512;
      const scale = Math.min(maxSample / image.naturalWidth, maxSample / image.naturalHeight, 1);
      const sampleWidth = Math.max(1, Math.round(image.naturalWidth * scale));
      const sampleHeight = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = sampleWidth;
      canvas.height = sampleHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
      const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
      let minX = sampleWidth;
      let minY = sampleHeight;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < sampleHeight; y += 1) {
        for (let x = 0; x < sampleWidth; x += 1) {
          if (pixels[(y * sampleWidth + x) * 4 + 3] > 12) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }
      const alphaBounds = maxX >= 0 ? {
        left: minX / sampleWidth,
        top: minY / sampleHeight,
        right: (maxX + 1) / sampleWidth,
        bottom: (maxY + 1) / sampleHeight
      } : null;
      const effects = [...boxNode.querySelectorAll('[data-mockup-element]')].map(node => {
        const effectRect = node.getBoundingClientRect();
        return { name: node.dataset.mockupElement, rect: { left: effectRect.left, top: effectRect.top, right: effectRect.right, bottom: effectRect.bottom } };
      });
      return {
        name: boxNode.dataset.mockupName,
        alt: image.alt,
        devices: image.dataset.devices,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        fit: style.objectFit,
        transform: style.transform,
        overflowX: boxStyle.overflowX,
        overflowY: boxStyle.overflowY,
        scrollWidth: boxNode.scrollWidth,
        scrollHeight: boxNode.scrollHeight,
        clientWidth: boxNode.clientWidth,
        clientHeight: boxNode.clientHeight,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        viewport: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
        alphaBounds,
        effects
      };
    });
    assert.ok(mockup.complete && mockup.naturalWidth > 0 && mockup.naturalHeight > 0, `Mockup source is incomplete: ${mockup.alt}`);
    assert.match(mockup.alt, /hardcover, iPad and iPhone/i, `Mockup alt text must identify all three devices: ${mockup.alt}`);
    assert.equal(mockup.devices, 'hardcover ipad iphone', `${mockup.name} must identify all three devices`);
    assert.equal(mockup.fit, 'contain', `Mockup must use object-fit: contain: ${mockup.alt}`);
    assert.equal(mockup.transform, 'none', `Mockup must not be stretched or transformed: ${mockup.alt}`);
    assert.ok(['hidden', 'clip'].includes(mockup.overflowX) && ['hidden', 'clip'].includes(mockup.overflowY), `${mockup.name} container must contain visual overflow`);
    assert.ok(mockup.scrollWidth <= mockup.clientWidth + 1 && mockup.scrollHeight <= mockup.clientHeight + 1, `${mockup.name} container has internal overflow`);
    assertInside(mockup.box, mockup.viewport, `${mockup.name} complete stage within viewport`);
    assertInside(mockup.rect, mockup.box, `${mockup.name} image within its container`);
    assertInside(mockup.rect, mockup.viewport, `${mockup.name} image within viewport`);
    assert.ok(mockup.box.right - mockup.rect.right >= 2, `${mockup.name} image has insufficient right-side clearance`);
    assert.ok(mockup.alphaBounds, `${mockup.name} transparent source content could not be measured`);
    for (const [edge, margin] of Object.entries({ left: mockup.alphaBounds.left, top: mockup.alphaBounds.top, right: 1 - mockup.alphaBounds.right, bottom: 1 - mockup.alphaBounds.bottom })) {
      assert.ok(margin >= 0.02, `${mockup.name} source content touches the ${edge} edge (${(margin * 100).toFixed(2)}% clearance)`);
    }
    const visualBounds = {
      left: mockup.rect.left + mockup.alphaBounds.left * mockup.rect.width,
      top: mockup.rect.top + mockup.alphaBounds.top * mockup.rect.height,
      right: mockup.rect.left + mockup.alphaBounds.right * mockup.rect.width,
      bottom: mockup.rect.top + mockup.alphaBounds.bottom * mockup.rect.height
    };
    assertInside(visualBounds, mockup.box, `${mockup.name} visible hardcover/iPad/iPhone pixels within container`);
    assertInside(visualBounds, mockup.viewport, `${mockup.name} visible hardcover/iPad/iPhone pixels within viewport`);
    assert.ok(mockup.box.right - visualBounds.right >= 4, `${mockup.name} visible right edge has insufficient clearance`);
    assert.deepEqual(mockup.effects.map(effect => effect.name).sort(), ['glow', 'pedestal', 'shadow'], `${mockup.name} must include glow, pedestal, and shadow elements`);
    for (const effect of mockup.effects) {
      assertInside(effect.rect, mockup.box, `${mockup.name} ${effect.name} within container`);
      assertInside(effect.rect, mockup.viewport, `${mockup.name} ${effect.name} within viewport`);
    }
  }
}

async function captureOurBooks(page, layout) {
  if (!['desktop', 'mobile'].includes(layout.name)) return null;
  const section = page.locator('.reference:visible [data-our-books-section]');
  assert.equal(await section.count(), 1, `Expected one focused Our Books marker for ${layout.name}`);
  await section.scrollIntoViewIfNeeded();
  const screenshot = path.join(outputDir, `our-books-${layout.name}-focused.png`);
  await section.screenshot({ path: screenshot, animations: 'disabled' });
  return screenshot;
}

async function assertNavigation(page, pageSlug, layout) {
  const button = pageSlug === 'homepage'
    ? page.locator(`.${layout.homepageRef}-ref [data-menu-button]`)
    : page.locator('[data-menu-button="secondaryMenu"]');
  await button.click();
  const panel = pageSlug === 'homepage'
    ? page.locator(`.${layout.homepageRef}-ref .menu-panel`)
    : page.locator('#secondaryMenu');
  await panel.waitFor({ state: 'visible' });
  assert.ok(await panel.locator('a[href="books.html"]').isVisible(), 'Responsive navigation did not expose Books');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
}

async function assertForm(page, pageSlug, layout) {
  if (pageSlug === 'homepage') {
    const form = page.locator(`.${layout.homepageRef}-ref form[data-email-form]`);
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
  assert.ok(activeLayouts.length > 0, 'TEST_LAYOUT must be desktop, tablet, or mobile');
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
            const focusedScreenshot = entry.slug === 'homepage' ? await captureOurBooks(page, layout) : null;
            await assertNavigation(page, entry.slug, layout);
            await assertForm(page, entry.slug, layout);

            assert.deepEqual(badResponses, [], `${label} loaded failing local resources`);
            assert.deepEqual(runtimeErrors, [], `${label} raised browser runtime errors`);
            assert.deepEqual(consoleErrors, [], `${label} logged browser console errors`);
            results.push({
              label,
              status: 'passed',
              screenshot: path.relative(root, screenshot),
              focusedScreenshot: focusedScreenshot ? path.relative(root, focusedScreenshot) : null,
              overflow
            });
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
