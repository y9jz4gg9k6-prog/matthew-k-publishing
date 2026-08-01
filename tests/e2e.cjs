const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'test-results', 'screenshots');
const approvedManifest = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'approved-mockups.json'), 'utf8'));
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
  { name: 'desktop', viewport: { width: 1672, height: 941 }, deviceScaleFactor: 2, isMobile: false, homepageRef: 'desktop' },
  { name: 'tablet', viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, isMobile: true, homepageRef: 'mobile' },
  { name: 'mobile', viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, homepageRef: 'mobile' }
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

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertApprovedAssetFiles() {
  assert.equal(sha256(path.join(root, approvedManifest.source)), approvedManifest.sourceSha256, 'Approved homepage source hash changed');
  for (const [name, group] of Object.entries(approvedManifest.groups)) {
    assert.equal(sha256(path.join(root, group.asset)), group.assetSha256, `${name} approved mockup asset hash changed`);
    assert.equal(sha256(path.join(root, group.highResolutionAsset)), group.highResolutionAssetSha256, `${name} original 8K mockup source hash changed`);
  }
}

async function assertApprovedPixelCrops(page) {
  const comparisons = await page.evaluate(async manifest => {
    const load = source => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Unable to load ${source}`));
      image.src = `/${source}`;
    });
    const source = await load(manifest.source);
    const results = [];
    for (const [name, group] of Object.entries(manifest.groups)) {
      const approved = await load(group.asset);
      const sourceCanvas = document.createElement('canvas');
      const approvedCanvas = document.createElement('canvas');
      sourceCanvas.width = approvedCanvas.width = group.width;
      sourceCanvas.height = approvedCanvas.height = group.height;
      const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
      const approvedContext = approvedCanvas.getContext('2d', { willReadFrequently: true });
      sourceContext.drawImage(source, group.x, group.y, group.width, group.height, 0, 0, group.width, group.height);
      approvedContext.drawImage(approved, 0, 0);
      const sourcePixels = sourceContext.getImageData(0, 0, group.width, group.height).data;
      const approvedPixels = approvedContext.getImageData(0, 0, group.width, group.height).data;
      let mismatches = 0;
      for (let index = 0; index < sourcePixels.length; index += 1) {
        if (sourcePixels[index] !== approvedPixels[index]) mismatches += 1;
      }
      results.push({
        name,
        mismatches,
        naturalWidth: approved.naturalWidth,
        naturalHeight: approved.naturalHeight
      });
    }
    return results;
  }, approvedManifest);
  for (const result of comparisons) {
    const expected = approvedManifest.groups[result.name];
    assert.equal(result.naturalWidth, expected.width, `${result.name} approved crop width changed`);
    assert.equal(result.naturalHeight, expected.height, `${result.name} approved crop height changed`);
    assert.equal(result.mismatches, 0, `${result.name} is not a pixel-exact crop of the approved homepage reference`);
  }
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
        const image = node.querySelector('img');
        const imageRect = image?.getBoundingClientRect();
        const imageStyle = image ? getComputedStyle(image) : null;
        return {
          name: node.dataset.mockupGroup,
          devices: node.dataset.devices,
          elements: node.dataset.elements,
          approvedGroup: node.dataset.approvedGroup || null,
          approvedAsset: node.dataset.approvedAsset || null,
          qualitySource: node.dataset.qualitySource || null,
          referenceAsset: node.dataset.referenceAsset || null,
          sourceRect: node.dataset.sourceRect || null,
          renderedAsset: image?.getAttribute('src') || null,
          image: image ? {
            currentSrc: image.currentSrc,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            renderedWidth: imageRect.width,
            renderedHeight: imageRect.height,
            srcset: image.getAttribute('srcset') || '',
            sizes: image.getAttribute('sizes') || '',
            objectFit: imageStyle.objectFit,
            filter: imageStyle.filter,
            transform: imageStyle.transform,
            devicePixelRatio: window.devicePixelRatio
          } : null,
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
    const approvedGroups = data.filter(group => group.approvedGroup);
    assert.equal(approvedGroups.length, 3, 'The visible homepage Our Books section must expose the three approved groups');
    for (const group of approvedGroups) {
      const manifestGroup = approvedManifest.groups[group.approvedGroup];
      assert.ok(manifestGroup, `Unknown approved homepage group ${group.approvedGroup}`);
      assert.equal(group.sourceRect, `${manifestGroup.x} ${manifestGroup.y} ${manifestGroup.width} ${manifestGroup.height}`, `${group.name} approved crop coordinates changed`);
      if (group.renderedAsset) {
        assert.equal(group.approvedAsset, manifestGroup.highResolutionAsset, `${group.name} does not identify the original 8K source`);
        assert.equal(group.referenceAsset, manifestGroup.asset, `${group.name} lost its approved desktop reference mapping`);
        assert.equal(group.renderedAsset, manifestGroup.highResolutionAsset, `${group.name} mobile overlay does not render the original 8K source`);
        assert.ok(group.image.currentSrc.endsWith(`/${manifestGroup.highResolutionAsset}`), `${group.name} currentSrc selected a stale or lower-resolution source`);
        assert.equal(group.image.naturalWidth, manifestGroup.highResolutionWidth, `${group.name} original source width changed`);
        assert.equal(group.image.naturalHeight, manifestGroup.highResolutionHeight, `${group.name} original source height changed`);
        assert.equal(group.image.srcset, '', `${group.name} must not expose low-resolution srcset candidates`);
        assert.equal(group.image.sizes, '', `${group.name} must not expose stale responsive sizes`);
        assert.equal(group.image.objectFit, 'contain', `${group.name} must use object-fit: contain`);
        assert.equal(group.image.filter, 'none', `${group.name} must not use an image filter`);
        assert.equal(group.image.transform, 'none', `${group.name} must not use transform enlargement`);
        assert.ok(group.image.naturalWidth / group.image.renderedWidth >= group.image.devicePixelRatio, `${group.name} source width does not support DPR ${group.image.devicePixelRatio}`);
        assert.ok(group.image.naturalHeight / group.image.renderedHeight >= group.image.devicePixelRatio, `${group.name} source height does not support DPR ${group.image.devicePixelRatio}`);
      } else {
        assert.equal(group.approvedAsset, manifestGroup.asset, `${group.name} desktop approved crop mapping changed`);
        assert.equal(group.qualitySource, manifestGroup.highResolutionAsset, `${group.name} desktop quality-source mapping changed`);
      }
      for (const effect of ['pedestal', 'glow', 'shadow']) assert.ok(group.elements.split(' ').includes(effect), `${group.name} approved composition is missing ${effect}`);
    }
    const visibleReference = await section.evaluate(node => ({
      mobile: node.classList.contains('mobile-ref'),
      source: node.querySelector(':scope > img')?.getAttribute('src'),
      sourceSha: node.querySelector(':scope > img')?.dataset.approvedSourceSha || null,
      approvedImages: [...node.querySelectorAll('.approved-mobile-group img')].map(image => image.getAttribute('src'))
    }));
    if (visibleReference.mobile) {
      assert.deepEqual(visibleReference.approvedImages.sort(), Object.values(approvedManifest.groups).map(group => group.highResolutionAsset).sort(), 'Mobile homepage does not render all three original 8K groups');
    } else {
      assert.equal(visibleReference.source, approvedManifest.source, 'Desktop homepage no longer renders the approved reference');
      assert.equal(visibleReference.sourceSha, approvedManifest.sourceSha256, 'Desktop homepage approved reference hash metadata changed');
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
    return approvedGroups.map(group => ({ page: pageSlug, group: group.approvedGroup, ...group.image })).filter(entry => entry.currentSrc);
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
      const sourceAspect = image.naturalWidth / image.naturalHeight;
      const renderedAspect = rect.width / rect.height;
      const contentWidth = renderedAspect > sourceAspect ? rect.height * sourceAspect : rect.width;
      const contentHeight = renderedAspect > sourceAspect ? rect.height : rect.width / sourceAspect;
      const contentLeft = rect.left + (rect.width - contentWidth) / 2;
      const contentTop = rect.top + (rect.height - contentHeight) / 2;
      const effects = [...boxNode.querySelectorAll('.mockup-glow,.mockup-pedestal,.mockup-shadow')].map(effect => {
        const effectRect = effect.getBoundingClientRect();
        return {
          className: effect.className,
          rect: { left: effectRect.left, top: effectRect.top, right: effectRect.right, bottom: effectRect.bottom }
        };
      });
      return {
        name: boxNode.dataset.mockupName,
        approvedGroup: boxNode.dataset.approvedGroup,
        approvedAsset: image.dataset.approvedAsset,
        elements: image.dataset.elements,
        source: image.getAttribute('src'),
        currentSrc: image.currentSrc,
        srcset: image.getAttribute('srcset') || '',
        sizes: image.getAttribute('sizes') || '',
        alt: image.alt,
        devices: image.dataset.devices,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        fit: style.objectFit,
        filter: style.filter,
        transform: style.transform,
        imageRendering: style.imageRendering,
        devicePixelRatio: window.devicePixelRatio,
        overflowX: boxStyle.overflowX,
        overflowY: boxStyle.overflowY,
        scrollWidth: boxNode.scrollWidth,
        scrollHeight: boxNode.scrollHeight,
        clientWidth: boxNode.clientWidth,
        clientHeight: boxNode.clientHeight,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        contentRect: { left: contentLeft, top: contentTop, right: contentLeft + contentWidth, bottom: contentTop + contentHeight, width: contentWidth, height: contentHeight },
        box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        viewport: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
        effects
      };
    });
    const manifestGroup = approvedManifest.groups[mockup.approvedGroup];
    assert.ok(manifestGroup, `${mockup.name} does not identify an approved Our Books group`);
    assert.ok(mockup.complete && mockup.naturalWidth > 0 && mockup.naturalHeight > 0, `Mockup source is incomplete: ${mockup.alt}`);
    assert.match(mockup.alt, /Exact approved.*hardcover, iPad and iPhone.*pedestal, glow, and shadow/i, `Mockup alt text must identify the complete approved composition: ${mockup.alt}`);
    assert.equal(mockup.devices, 'hardcover ipad iphone', `${mockup.name} must identify all three devices`);
    assert.equal(mockup.elements, 'hardcover ipad iphone pedestal glow shadow', `${mockup.name} must preserve every approved visual element`);
    assert.equal(mockup.approvedAsset, manifestGroup.highResolutionAsset, `${mockup.name} original source metadata changed`);
    assert.equal(mockup.source, manifestGroup.highResolutionAsset, `${mockup.name} is not rendering the original 8K asset`);
    assert.ok(mockup.currentSrc.endsWith(`/${manifestGroup.highResolutionAsset}`), `${mockup.name} currentSrc selected a stale or lower-resolution source`);
    assert.equal(mockup.naturalWidth, manifestGroup.highResolutionWidth, `${mockup.name} original source width changed`);
    assert.equal(mockup.naturalHeight, manifestGroup.highResolutionHeight, `${mockup.name} original source height changed`);
    assert.equal(mockup.srcset, '', `${mockup.name} must not expose low-resolution srcset candidates`);
    assert.equal(mockup.sizes, '', `${mockup.name} must not expose stale responsive sizes`);
    assert.equal(mockup.fit, 'contain', `Mockup must use object-fit: contain: ${mockup.alt}`);
    assert.equal(mockup.filter, 'none', `Mockup must not use blur, sharpening, or other filters: ${mockup.alt}`);
    assert.equal(mockup.transform, 'none', `Mockup must not be stretched or transformed: ${mockup.alt}`);
    assert.ok(['hidden', 'clip'].includes(mockup.overflowX) && ['hidden', 'clip'].includes(mockup.overflowY), `${mockup.name} container must contain visual overflow`);
    assert.ok(mockup.scrollWidth <= mockup.clientWidth + 1 && mockup.scrollHeight <= mockup.clientHeight + 1, `${mockup.name} container has internal overflow`);
    assertInside(mockup.box, mockup.viewport, `${mockup.name} complete stage within viewport`);
    assertInside(mockup.rect, mockup.box, `${mockup.name} image within its container`);
    assertInside(mockup.rect, mockup.viewport, `${mockup.name} image within viewport`);
    assertInside(mockup.contentRect, mockup.box, `${mockup.name} complete 8K device composition within its container`);
    assertInside(mockup.contentRect, mockup.viewport, `${mockup.name} complete 8K device composition within viewport`);
    assert.equal(mockup.effects.length, 3, `${mockup.name} must render pedestal, glow, and shadow as complete stage layers`);
    for (const effect of mockup.effects) assertInside(effect.rect, mockup.box, `${mockup.name} ${effect.className} within its container`);
    const clearances = {
      left: mockup.rect.left - mockup.box.left,
      top: mockup.rect.top - mockup.box.top,
      right: mockup.box.right - mockup.rect.right,
      bottom: mockup.box.bottom - mockup.rect.bottom
    };
    for (const [edge, clearance] of Object.entries(clearances)) assert.ok(clearance >= 2, `${mockup.name} exact approved composition has insufficient ${edge}-side clearance`);
    assert.ok(mockup.naturalWidth / mockup.contentRect.width >= mockup.devicePixelRatio, `${mockup.name} source width does not support DPR ${mockup.devicePixelRatio}`);
    assert.ok(mockup.naturalHeight / mockup.contentRect.height >= mockup.devicePixelRatio, `${mockup.name} source height does not support DPR ${mockup.devicePixelRatio}`);
  }
  return await containers.evaluateAll((nodes, slug) => nodes.map(boxNode => {
    const image = boxNode.querySelector('.mockup-image');
    const rect = image.getBoundingClientRect();
    return {
      page: slug,
      group: boxNode.dataset.approvedGroup,
      currentSrc: image.currentSrc,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      srcset: image.getAttribute('srcset') || '',
      sizes: image.getAttribute('sizes') || '',
      objectFit: getComputedStyle(image).objectFit,
      filter: getComputedStyle(image).filter,
      transform: getComputedStyle(image).transform,
      devicePixelRatio: window.devicePixelRatio
    };
  }), pageSlug);
}

async function captureApprovedArea(page, pageSlug, layout) {
  const selectors = {
    homepage: '.reference:visible [data-our-books-section]',
    books: '.page-main',
    unshakable: '.detail-panel',
    beginners: '.detail-panel',
    experts: '.detail-panel'
  };
  if (!selectors[pageSlug]) return null;
  const area = page.locator(selectors[pageSlug]);
  assert.equal(await area.count(), 1, `Expected one focused approved area for ${pageSlug}-${layout.name}`);
  await area.scrollIntoViewIfNeeded();
  const screenshot = path.join(outputDir, `approved-${pageSlug}-${layout.name}-focused.png`);
  await area.screenshot({ path: screenshot, animations: 'disabled', scale: 'device' });
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
  assertApprovedAssetFiles();
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
  let approvedPixelsVerified = false;

  try {
    for (const layout of activeLayouts) {
      for (const entry of activePages) {
        const label = `${entry.slug}-${layout.name}`;
        const browser = await chromium.launch({ headless: true, executablePath });
        let context;
        try {
          context = await browser.newContext({ viewport: layout.viewport, deviceScaleFactor: layout.deviceScaleFactor, isMobile: layout.isMobile });
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
            await page.locator('img').evaluateAll(images => Promise.all(images.map(image => {
              if (image.complete) return undefined;
              return new Promise(resolve => {
                image.addEventListener('load', resolve, { once: true });
                image.addEventListener('error', resolve, { once: true });
              });
            })));
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            assert.ok(overflow <= 0, `${label} has ${overflow}px of horizontal overflow`);
            await assertInternalLinks(page, baseURL);
            await assertImages(page);
            if (!approvedPixelsVerified) {
              await assertApprovedPixelCrops(page);
              approvedPixelsVerified = true;
            }
            const imageTelemetry = await assertMockups(page, entry.mockups, entry.slug);

            const screenshot = path.join(outputDir, `${label}.png`);
            await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
            const focusedScreenshot = await captureApprovedArea(page, entry.slug, layout);
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
              overflow,
              deviceScaleFactor: layout.deviceScaleFactor,
              imageTelemetry
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
