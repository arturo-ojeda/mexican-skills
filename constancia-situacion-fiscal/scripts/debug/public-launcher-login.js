const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const SKILL_ROOT = path.resolve(__dirname, '..', '..');
const CDP_URL = process.env.SAT_CDP_URL || 'http://127.0.0.1:18800';
const RFC = process.env.SAT_RFC;
const PASSWORD = process.env.SAT_PASSWORD;
const LOGIN_URL = process.env.SAT_LAUNCHER_URL || 'https://wwwmat.sat.gob.mx/app/seg/faces/pages/lanzador.jsf?url=/operacion/53027/genera-tu-constancia-de-situacion-fiscal.&tipoLogeo=c&target=principal&hostServer=https://wwwmat.sat.gob.mx';
const SOLVER = path.join(__dirname, '..', 'solve-captcha-2captcha.js');
const DEBUG_DIR = process.env.SAT_DEBUG_DIR || path.join(SKILL_ROOT, 'artifacts', 'debug');

if (!RFC || !PASSWORD) throw new Error('Define SAT_RFC y SAT_PASSWORD en el entorno');

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
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  console.log('initial url', page.url(), 'title', await page.title().catch(() => ''));
  const cap = await findCaptcha(page);
  if (!cap) throw new Error('No se encontró el CAPTCHA');
  const capPath = path.join(DEBUG_DIR, 'launcher-captcha.png');
  await cap.screenshot({ path: capPath });
  const captcha = execFileSync('node', [SOLVER, capPath], { cwd: process.cwd(), encoding: 'utf8', env: process.env }).trim();
  console.log('captcha', captcha);
  await page.fill('#rfc', RFC);
  await page.fill('#password', PASSWORD);
  await page.fill('#userCaptcha', captcha);
  await page.click('#submit', { noWaitAfter: true });
  for (const ms of [3000, 8000, 15000, 25000]) {
    await page.waitForTimeout(ms);
    const tag = `launch-${ms}ms`;
    console.log('\n===', tag, '===');
    console.log('url', page.url());
    console.log('title', await page.title().catch(() => ''));
    const frames = page.frames().map((f) => ({ name: f.name(), url: f.url() }));
    console.log('frames', JSON.stringify(frames, null, 2));
    const body = await page.locator('body').innerText().catch(() => '');
    console.log('bodySnippet', String(body).slice(0, 2000));
    console.log('htmlSnippet', (await page.content().catch(() => '')).slice(0, 3000));
    await page.screenshot({ path: path.join(DEBUG_DIR, `${tag}.png`), fullPage: true }).catch(() => {});
  }
  await browser.close();
})();
