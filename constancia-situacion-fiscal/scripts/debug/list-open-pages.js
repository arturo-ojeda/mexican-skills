const { chromium } = require('playwright-core');

const CDP_URL = process.env.SAT_CDP_URL || 'http://127.0.0.1:18800';

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  for (const [ci, context] of browser.contexts().entries()) {
    for (const [pi, page] of context.pages().entries()) {
      console.log('context', ci, 'page', pi, 'url', page.url(), 'title', await page.title().catch(() => ''));
      console.log('frames', JSON.stringify(page.frames().map((f) => ({ name: f.name(), url: f.url() })), null, 2));
      const body = await page.locator('body').innerText().catch(() => '');
      console.log('bodySnippet', String(body).slice(0, 1000));
      console.log('---');
    }
  }
  await browser.close();
})();
