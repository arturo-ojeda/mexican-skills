const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const SKILL_ROOT = path.resolve(__dirname, '..', '..');
const CDP_URL = process.env.SAT_CDP_URL || 'http://127.0.0.1:18800';
const RFC = process.env.SAT_RFC;
const PASSWORD = process.env.SAT_PASSWORD;
const DEBUG_DIR = process.env.SAT_DEBUG_DIR || path.join(SKILL_ROOT, 'artifacts', 'debug');

const captcha = process.argv[2];
if (!RFC || !PASSWORD) throw new Error('Define SAT_RFC y SAT_PASSWORD en el entorno');
if (!captcha) throw new Error('captcha arg requerido');

fs.mkdirSync(DEBUG_DIR, { recursive: true });

async function findCaptcha(page) {
  const selectors = ['#captchaImg', '#imgCaptcha', '#divCaptcha img', 'label#divCaptcha img', 'img[alt*="captcha" i]', 'img[src*="captcha" i]', 'img[id*="captcha" i]', 'img[class*="captcha" i]', 'img[src^="data:image/"]'];
  for (const s of selectors) {
    const l = page.locator(s).first();
    if (await l.count()) return l;
  }
  return null;
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] || await browser.newContext({ acceptDownloads: true });
  await context.clearCookies().catch(() => {});
  const page = await context.newPage();
  await page.goto('https://cfdiau.sat.gob.mx/nidp/app/login?id=SATUPCFDiCon&sid=0&option=credential&sid=0', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const cap = await findCaptcha(page);
  if (cap) await cap.screenshot({ path: path.join(DEBUG_DIR, 'latest-captcha.png') });
  await page.fill('#rfc', RFC);
  await page.fill('#password', PASSWORD);
  await page.fill('#userCaptcha', captcha);
  await page.click('#submit', { noWaitAfter: true });
  for (const ms of [3000, 8000, 15000, 25000]) {
    await page.waitForTimeout(ms);
    const tag = `${ms}ms`;
    console.log('\n===', tag, '===');
    console.log('url', page.url());
    console.log('title', await page.title().catch(() => ''));
    const frames = page.frames().map((f) => ({ name: f.name(), url: f.url() }));
    console.log('frames', JSON.stringify(frames, null, 2));
    const html = (await page.content().catch(() => ''));
    console.log('htmlSnippet', html.slice(0, 2500));
    const body = await page.locator('body').innerText().catch(() => '');
    console.log('bodySnippet', String(body).slice(0, 2000));
    await page.screenshot({ path: path.join(DEBUG_DIR, `${tag}.png`), fullPage: true }).catch(() => {});
  }
  await browser.close();
})();
