const { chromium } = require('playwright-core');

const CDP_URL = process.env.SAT_CDP_URL || 'http://127.0.0.1:18800';

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().includes('/operacion/53027/'));
  if (!page) throw new Error('No se encontró una página viva del trámite 53027');
  const frame = page.frames().find((f) => f.url().includes('ConsultaTramite'));
  if (!frame) throw new Error('No se encontró el frame ConsultaTramite');
  console.log('frame url', frame.url());
  const body = await frame.locator('body').innerText().catch(() => '');
  console.log('body', body.slice(0, 4000));
  const html = await frame.content().catch(() => '');
  console.log('html', html.slice(0, 6000));
  const buttons = await frame.locator('a,button,input[type=button],input[type=submit]').evaluateAll((nodes) => nodes.map((n) => ({
    tag: n.tagName,
    text: (n.innerText || n.value || '').trim(),
    id: n.id,
    name: n.name,
    href: n.href || '',
    onclick: n.getAttribute('onclick') || '',
  })).filter((x) => x.text || x.href || x.onclick));
  console.log('buttons', JSON.stringify(buttons, null, 2));
  await browser.close();
})();
