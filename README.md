# Matthew K Publishing

Static website for Matthew K Publishing, rebuilt from the V33 foundation with the approved homepage render.

## Chromium QA

Install dependencies and run the complete desktop/mobile suite:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm run test:chromium
```

The suite audits layout overflow, internal links, images, console errors, navigation, forms, and full mockup visibility. It writes desktop and mobile full-page screenshots for every navigable page to `test-results/screenshots/`.
