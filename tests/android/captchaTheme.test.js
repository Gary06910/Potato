'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { DOMParser } = require('@xmldom/xmldom');

const projectRoot = path.resolve(__dirname, '../../apps/tokenm-android');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function isHexDigit(value) {
  return value.length === 1 && '0123456789abcdefABCDEF'.includes(value);
}

function decodeSvgUriPayload(value) {
  let output = '';
  let index = 0;
  while (index < value.length) {
    const current = value.substring(index, index + 1);
    const hasEncodedByte = current === '%' && index + 2 < value.length
      && isHexDigit(value.substring(index + 1, index + 2))
      && isHexDigit(value.substring(index + 2, index + 3));
    if (!hasEncodedByte) {
      output += current;
      index += 1;
      continue;
    }
    let encodedRun = '';
    while (index + 2 < value.length
      && value.substring(index, index + 1) === '%'
      && isHexDigit(value.substring(index + 1, index + 2))
      && isHexDigit(value.substring(index + 2, index + 3))) {
      encodedRun += value.substring(index, index + 3);
      index += 3;
    }
    output += decodeURIComponent(encodedRun);
  }
  return output;
}

function parseSvgXml(value) {
  const errors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message)
    }
  }).parseFromString(value, 'image/svg+xml');
  assert.deepEqual(errors, []);
  assert.equal(document.documentElement.tagName, 'svg');
  return document.documentElement;
}

function officialAppSvgPayload(svg) {
  return `data:image/svg+xml;utf8,${svg
    .replaceAll('#', '%23')
    .replaceAll('"', "'")
    .replaceAll('<', '%3C')
    .replaceAll('>', '%3E')}`;
}

async function withOfficialCaptchaStub(config, run) {
  const captchaModulePath = path.join(
    projectRoot,
    'uni_modules/uni-captcha/uniCloud/cloudfunctions/common/uni-captcha/index.js'
  );
  const records = [];
  const collection = {
    async add(record) {
      const stored = { ...record, _id: `local-${records.length + 1}` };
      records.push(stored);
      return { id: stored._id };
    },
    where() {
      return {
        orderBy() { return this; },
        limit() { return this; },
        async get() {
          return { data: records.length > 0 ? [records[records.length - 1]] : [] };
        }
      };
    },
    doc(id) {
      return {
        async update(fields) {
          const record = records.find((item) => item._id === id);
          if (record) Object.assign(record, fields);
          return { updated: record ? 1 : 0 };
        }
      };
    }
  };
  const database = {
    collection: () => collection,
    command: { or: (clauses) => ({ or: clauses }) }
  };
  const originalLoad = Module._load;
  const previousUniCloud = globalThis.uniCloud;
  const previousContext = globalThis.__ctx__;
  globalThis.uniCloud = { database: () => database };
  globalThis.__ctx__ = { DEVICEID: 'local-device', CLIENTIP: '127.0.0.1' };
  Module._load = function loadWithCaptchaConfig(request, parent, isMain) {
    if (request === 'uni-config-center') {
      return () => ({
        hasFile: (filename) => filename === 'config.json',
        config: () => JSON.parse(JSON.stringify(config))
      });
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(captchaModulePath)];
  try {
    const captcha = require(captchaModulePath);
    return await run(captcha, records);
  } finally {
    delete require.cache[require.resolve(captchaModulePath)];
    Module._load = originalLoad;
    if (previousUniCloud === undefined) delete globalThis.uniCloud;
    else globalThis.uniCloud = previousUniCloud;
    if (previousContext === undefined) delete globalThis.__ctx__;
    else globalThis.__ctx__ = previousContext;
  }
}

function validateOfficialMixedSvgPayload(source) {
  const prefix = 'data:image/svg+xml;utf8,';
  assert.equal(source.startsWith(prefix), true);
  const body = source.substring(prefix.length);
  assert.equal(body.includes('%3C'), true);
  assert.equal(body.includes('%3E'), true);
  assert.equal(body.includes('%23'), true);
  assert.equal(body.includes('100%'), true);
  assert.throws(() => decodeURIComponent(body), URIError);

  const svg = decodeSvgUriPayload(body);
  const base64Body = Buffer.from(svg, 'utf8').toString('base64');
  const decodedBytes = Buffer.from(base64Body, 'base64');
  assert.equal(decodedBytes.toString('base64'), base64Body);
  const decodedSvg = new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes);
  const root = parseSvgXml(decodedSvg);
  assert.equal(root.getAttribute('width'), '150');
  assert.equal(root.getAttribute('height'), '50');
  assert.equal(root.getAttribute('viewBox'), '0,0,150,50');
  assert.match(decodedSvg, /<\/svg>$/);

  return {
    prefix,
    type: 'svg-utf8',
    length: source.length,
    encoding: 'MIXED_ENCODING'
  };
}

test('captcha SVG URI normalization decodes encoded XML bytes and preserves bare percentages', () => {
  const cases = [
    {
      input: "<svg width='100%'><path fill='%23abc'/></svg>",
      expected: "<svg width='100%'><path fill='#abc'/></svg>"
    },
    {
      input: "%3Csvg width='100%'%3E%3Cpath fill='%23abc'/%3E%3C/svg%3E",
      expected: "<svg width='100%'><path fill='#abc'/></svg>"
    },
    {
      input: '%3Csvg%20viewBox%3D%220%200%20150%2050%22%3E%3Ctext%3E100%25%3C%2Ftext%3E%3C%2Fsvg%3E',
      expected: '<svg viewBox="0 0 150 50"><text>100%</text></svg>'
    },
    {
      input: '%3Csvg%3E<text>100%%20%23</text>%3C/svg%3E',
      expected: '<svg><text>100% #</text></svg>'
    }
  ];

  for (const fixture of cases) {
    assert.equal(decodeSvgUriPayload(fixture.input), fixture.expected);
  }
});

test('captcha output is one valid UTF-8 SVG Base64 source format', () => {
  const auth = read('services/auth-service.uts');
  const encodedXml = '%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%%22 height=%22100%%22 viewBox=%220 0 150 50%22%3E%3Crect width=%22100%%22 height=%22100%%22 fill=%22%23FFFFFF%22/%3E%3Ctext%3E%E9%AA%8C%E8%AF%81 100%25 %26amp; ready%3C/text%3E%3C/svg%3E';
  const svg = decodeSvgUriPayload(encodedXml);
  const source = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  const decodedBytes = Buffer.from(source.substring('data:image/svg+xml;base64,'.length), 'base64');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes);
  const root = parseSvgXml(decoded);

  assert.equal(decoded, svg);
  assert.match(decoded, /^<svg\b/);
  assert.match(decoded, /<rect width="100%" height="100%" fill="#FFFFFF"\/>/);
  assert.match(decoded, /<text>验证 100% &amp; ready<\/text>/);
  assert.match(decoded, /<\/svg>$/);
  assert.equal(root.getAttribute('width'), '100%');
  assert.equal(root.getAttribute('height'), '100%');
  assert.equal(root.getAttribute('viewBox'), '0 0 150 50');
  assert.match(auth, /throw new Error\(['"]验证码图片格式不是 SVG UTF-8 URI['"]\)/);
  assert.match(auth, /return `\$\{SVG_BASE64_PREFIX\}\$\{encoded\}`/);
  assert.doesNotMatch(auth, /data:image\/bmp|wildcard-base64|svg-utf8/);
  assert.doesNotMatch(auth, /\.split\(\s*['"]%23['"]\s*\)/);
});

test('deployed uni-id-co contract produces mixed-encoded SVG and the selected transform validates it completely', () => {
  const config = JSON.parse(read('uni_modules/uni-config-center/uniCloud/cloudfunctions/common/uni-config-center/uni-captcha/config.json'));
  const createCaptcha = read('uni_modules/uni-id-pages-x/uniCloud/cloudfunctions/uni-id-co/module/verify/create-captcha.js');
  const refreshCaptcha = read('uni_modules/uni-id-pages-x/uniCloud/cloudfunctions/uni-id-co/module/verify/refresh-captcha.js');
  const commonCaptcha = read('uni_modules/uni-captcha/uniCloud/cloudfunctions/common/uni-captcha/index.js');
  const backendSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="50" viewBox="0,0,150,50"><rect width="100%" height="100%" fill="#FFFAE8"/><text>验证 100%</text></svg>';
  const rawPayload = officialAppSvgPayload(backendSvg);
  const rawBody = rawPayload.substring('data:image/svg+xml;utf8,'.length);

  assert.equal(config.mode, 'svg');
  assert.match(createCaptcha, /this\.uniCaptcha\.create\(\{[\s\S]*deviceId,[\s\S]*scene,[\s\S]*uniPlatform:\s*platform[\s\S]*\}\)/);
  assert.match(refreshCaptcha, /this\.uniCaptcha\.refresh\(\{[\s\S]*deviceId,[\s\S]*scene,[\s\S]*uniPlatform:\s*platform[\s\S]*\}\)/);
  assert.doesNotMatch(`${createCaptcha}\n${refreshCaptcha}`, /isUniAppX|mode\s*:/);
  assert.match(commonCaptcha, /data:image\/svg\+xml;utf8,/);
  assert.match(commonCaptcha, /data:image\/bmp;base64,/);

  assert.equal(rawPayload.startsWith('data:image/svg+xml;utf8,'), true);
  assert.equal(rawBody.includes('%3C'), true);
  assert.equal(rawBody.includes('%3E'), true);
  assert.equal(rawBody.includes('%23'), true);
  assert.equal(rawBody.includes('100%'), true);
  assert.throws(() => decodeURIComponent(rawBody), URIError);

  const normalizedSvg = decodeSvgUriPayload(rawBody);
  const normalizedSource = `data:image/svg+xml;base64,${Buffer.from(normalizedSvg, 'utf8').toString('base64')}`;
  const base64Body = normalizedSource.substring('data:image/svg+xml;base64,'.length);
  const decodedBytes = Buffer.from(base64Body, 'base64');
  assert.equal(decodedBytes.toString('base64'), base64Body);
  const decodedSvg = new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes);
  const root = parseSvgXml(decodedSvg);

  assert.equal(decodedSvg, backendSvg.replaceAll('"', "'"));
  assert.equal(root.getAttribute('width'), '150');
  assert.equal(root.getAttribute('height'), '50');
  assert.equal(root.getAttribute('viewBox'), '0,0,150,50');
});

test('official local captcha create and refresh produce validated mixed SVG payloads', async (context) => {
  const config = JSON.parse(read('uni_modules/uni-config-center/uniCloud/cloudfunctions/common/uni-config-center/uni-captcha/config.json'));
  await withOfficialCaptchaStub(config, async (captcha, records) => {
    const createRegister = await captcha.create({
      deviceId: 'local-register-device',
      clientIP: '127.0.0.1',
      scene: 'register',
      uniPlatform: 'app'
    });
    assert.equal(createRegister.code, 0);
    const createMeta = validateOfficialMixedSvgPayload(createRegister.captchaBase64);
    context.diagnostic(`register create: prefix=${createMeta.prefix} type=${createMeta.type} length=${createMeta.length} encoding=${createMeta.encoding}`);

    const refreshRegister = await captcha.refresh({
      deviceId: 'local-register-device',
      scene: 'register',
      uniPlatform: 'app'
    });
    assert.equal(refreshRegister.code, 0);
    const refreshMeta = validateOfficialMixedSvgPayload(refreshRegister.captchaBase64);
    context.diagnostic(`register refresh: prefix=${refreshMeta.prefix} type=${refreshMeta.type} length=${refreshMeta.length} encoding=${refreshMeta.encoding}`);

    const createLogin = await captcha.create({
      deviceId: 'local-login-device',
      clientIP: '127.0.0.1',
      scene: 'login-by-pwd',
      uniPlatform: 'app'
    });
    assert.equal(createLogin.code, 0);
    const loginMeta = validateOfficialMixedSvgPayload(createLogin.captchaBase64);
    context.diagnostic(`login create: prefix=${loginMeta.prefix} type=${loginMeta.type} length=${loginMeta.length} encoding=${loginMeta.encoding}`);
    assert.equal(records.length, 3);
  });
});

test('official create and refresh stay on uni-id-co and image binding exposes safe load/error observation', () => {
  const auth = read('services/auth-service.uts');
  const pages = [read('pages/login/index.uvue'), read('pages/register/index.uvue')];

  assert.match(auth, /uniIdCo\.createCaptcha\(\s*\{\s*scene\s*\}\s*\)/);
  assert.match(auth, /uniIdCo\.refreshCaptcha\(\s*\{\s*scene\s*\}\s*\)/);
  assert.doesNotMatch(auth, /uni-captcha-co|uniCaptchaCo/);

  for (const page of pages) {
    assert.match(page, /<view[^>]+class=["']captcha-refresh["'][^>]*>[\s\S]*?<image[^>]+v-if=["']captchaBase64\.length > 0["']/);
    assert.doesNotMatch(page, /<button[^>]+class=["']captcha-refresh["']/);
    assert.match(page, /<image[^>]+v-if=["']captchaBase64\.length > 0["'][^>]+:src=["']captchaBase64["'][^>]+mode=["']widthFix["'][^>]+@load=["']captchaImageLoad["'][^>]+@error=["']captchaImageError["']/);
    assert.match(page, /\.captcha-refresh\s*\{[^}]*width:\s*132px[^}]*height:\s*48px[^}]*overflow:\s*hidden/);
    assert.match(page, /\.captcha-image\s*\{[^}]*width:\s*126px[^}]*height:\s*44px/);
    const imageLogs = page.split('\n').filter((line) => line.includes('[captcha-image]')).join('\n');
    assert.match(imageLogs, /load success/);
    assert.match(imageLogs, /load error/);
    assert.doesNotMatch(imageLogs, /captchaBase64\.value\s*[,)]|src\s*[,)]|payload|captcha answer|password|token|secret/i);
  }
});

test('no saved theme preference means the complete Android default is light', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pages = JSON.parse(read('pages.json'));
  const tokens = read('uni.scss');
  const app = read('App.uvue');

  assert.equal(manifest.app.defaultAppTheme, 'light');
  assert.equal(pages.globalStyle.navigationBarBackgroundColor, '#f5f3ee');
  assert.equal(pages.globalStyle.navigationBarTextStyle, 'black');
  assert.equal(pages.globalStyle.backgroundColor, '#f5f3ee');
  assert.equal(pages.globalStyle.backgroundColorContent, '#f5f3ee');
  assert.equal(pages.globalStyle.backgroundTextStyle, 'dark');
  assert.equal(pages.pages.every((entry) => entry.style.backgroundColor === '#f5f3ee'), true);

  assert.match(tokens, /\$tm-bg:\s*#f5f3ee/);
  assert.match(tokens, /\$tm-surface-1:\s*#fffdf9/);
  assert.match(tokens, /\$tm-text-1:\s*#202a36/);
  assert.match(app, /\.primary-surface\s*\{[^}]*background-color:\s*\$tm-accent/);
  assert.doesNotMatch(`${tokens}\n${app}\n${JSON.stringify(pages)}`, /#07111f|#0d1b2b|#122238|#f2f7ff|#b4c2d4/);
  assert.doesNotMatch(app, /theme[^\n]{0,80}(?:getStorageSync|setStorageSync)/i);
});

test('login register and all primary pages inherit the shared light surfaces', () => {
  const app = read('App.uvue');
  const tokens = read('uni.scss');
  const pagePaths = [
    'pages/login/index.uvue',
    'pages/register/index.uvue',
    'pages/dashboard/index.uvue',
    'pages/tasks/index.uvue',
    'pages/desktops/index.uvue',
    'pages/settings/index.uvue'
  ];

  assert.match(app, /\.page-shell\s*\{[^}]*background-color:\s*\$tm-bg[^}]*color:\s*\$tm-text-1/);
  assert.match(app, /\.surface\s*\{[^}]*background-color:\s*\$tm-surface-1/);
  assert.match(app, /\.input\s*\{[^}]*border-color:\s*\$tm-line-strong[^}]*color:\s*\$tm-text-1[^}]*background-color:\s*\$tm-surface-1/);
  assert.match(tokens, /\$tm-line-strong:\s*#c9c2b7/);
  for (const pagePath of pagePaths) {
    assert.match(read(pagePath), /class=["'][^"']*page-shell/);
  }
});
