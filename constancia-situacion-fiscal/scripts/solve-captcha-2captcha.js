#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.TWOCAPTCHA_API_KEY || process.env.CAPTCHA_SOLVER_API_KEY;
const imagePath = process.argv[2];

if (!API_KEY) {
  console.error('Falta TWOCAPTCHA_API_KEY (o CAPTCHA_SOLVER_API_KEY como alias)');
  process.exit(2);
}

if (!imagePath) {
  console.error('Usage: node solve-captcha-2captcha.js <image-path>');
  process.exit(2);
}

const absolutePath = path.resolve(imagePath);
if (!fs.existsSync(absolutePath)) {
  console.error(`Image not found: ${absolutePath}`);
  process.exit(2);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function submitCaptcha(base64Body) {
  const params = new URLSearchParams({
    key: API_KEY,
    method: 'base64',
    body: base64Body,
    json: '1',
    phrase: '0',
    regsense: '0',
    numeric: '0',
    min_len: '5',
    max_len: '8',
    language: '2'
  });

  const response = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  const json = await response.json();
  if (json.status !== 1) {
    throw new Error(`2Captcha submit failed: ${json.request}`);
  }

  return json.request;
}

async function pollResult(id) {
  const url = new URL('https://2captcha.com/res.php');
  url.searchParams.set('key', API_KEY);
  url.searchParams.set('action', 'get');
  url.searchParams.set('id', id);
  url.searchParams.set('json', '1');

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    await sleep(attempt === 1 ? 7000 : 5000);
    const response = await fetch(url);
    const json = await response.json();

    if (json.status === 1) {
      return String(json.request || '').trim();
    }

    if (json.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2Captcha polling failed: ${json.request}`);
    }
  }

  throw new Error('2Captcha timed out waiting for result');
}

async function main() {
  const body = fs.readFileSync(absolutePath).toString('base64');
  const id = await submitCaptcha(body);
  const text = await pollResult(id);
  process.stdout.write(text);
}

main().catch(err => {
  console.error(err.message || String(err));
  process.exit(1);
});
