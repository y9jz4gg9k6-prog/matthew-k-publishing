# Matthew K Publishing

Static website for Matthew K Publishing, rebuilt from the V33 foundation with the approved homepage render.

## Chromium QA

Install dependencies and run the complete desktop/mobile suite:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm run test:chromium
```

The suite audits desktop, tablet, and mobile layout overflow, internal links, images, console errors, navigation, forms, source transparency, and full mockup/stage bounding-box containment. It writes full-page screenshots for every navigable page plus focused desktop and mobile Our Books screenshots to `test-results/screenshots/`.
