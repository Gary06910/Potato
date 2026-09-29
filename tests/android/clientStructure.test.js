'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../apps/tokenm-android');
const externalSourceDirectories = new Set(['uni_modules', 'unpackage']);

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function occurrenceCount(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function sourceFiles(directory = projectRoot) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (externalSourceDirectories.has(entry.name)) return [];
      return sourceFiles(absolute);
    }
    return /\.(uts|uvue|scss)$/.test(entry.name) ? [absolute] : [];
  });
}

test('uni-app x manifest and all declared VDOM pages are structurally present', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pages = JSON.parse(read('pages.json'));

  assert.deepEqual(manifest['uni-app-x'], {});
  assert.equal(manifest.appid, '__UNI__46C9063');
  assert.equal(pages.pages.length, 14);
  assert.equal(new Set(pages.pages.map((entry) => entry.path)).size, 14);

  for (const entry of pages.pages) {
    const relative = `${entry.path}.uvue`;
    assert.equal(fs.existsSync(path.join(projectRoot, relative)), true, `${relative} is missing`);
    assert.match(read(relative), /<scroll-view\b/, `${relative} must provide its VDOM scroll root`);
    assert.match(read(relative), /<scroll-view\b[^>]*direction=["']vertical["']/, `${relative} must opt into vertical VDOM scrolling`);
  }
});

test('Android page scroll roots have a bounded flex chain and keep the frozen layout subset', () => {
  const app = read('App.uvue');
  const pages = JSON.parse(read('pages.json')).pages.map((entry) => read(`${entry.path}.uvue`));
  const combined = [app, ...pages].join('\n');

  assert.match(app, /\.page-shell\s*\{[\s\S]*flex:\s*1;[\s\S]*\}/);
  assert.match(app, /\.page-scroll\s*\{[\s\S]*flex:\s*1;[\s\S]*min-height:\s*0;[\s\S]*\}/);
  assert.doesNotMatch(combined, /100vh|100vw|\bvh\b|\bvw\b|\bcalc\s*\(|\bvar\s*\(|animation|keyframes|:active/);
  assert.doesNotMatch(read('pages/permission/index.uvue'), /\.permission-page\s*\{[^}]*flex\s*:/);
  assert.doesNotMatch(read('pages/onboarding/index.uvue'), /\.onboarding-page\s*\{[^}]*flex\s*:/);
});

test('relative imports resolve and the client keeps the frozen visual/runtime boundaries', () => {
  const files = sourceFiles();
  const combined = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

  assert.doesNotMatch(combined, /\brpx\b/i);
  assert.doesNotMatch(combined, /\bwx\./);
  assert.doesNotMatch(combined, /微信|通知额度|订阅授权/);

  for (const file of files) {
    if (!/\.(uts|uvue)$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const imports = source.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g);
    for (const match of imports) {
      const target = path.resolve(path.dirname(file), match[1]);
      assert.equal(fs.existsSync(target), true, `${path.relative(projectRoot, file)} imports missing ${match[1]}`);
    }
  }
});

test('bottom navigation exposes exactly the four frozen destinations', () => {
  const tabs = read('components/tm-tab-bar/tm-tab-bar.uvue');
  const configured = [...tabs.matchAll(/\{ key: '[^']+', label: '([^']+)', url: '([^']+)' \}/g)]
    .map((match) => ({ label: match[1], url: match[2] }));

  assert.deepEqual(configured, [
    { label: '首页', url: '/pages/dashboard/index' },
    { label: '任务', url: '/pages/tasks/index' },
    { label: '电脑', url: '/pages/desktops/index' },
    { label: '设置', url: '/pages/settings/index' }
  ]);
});

test('shared back control has a visible direct label and preserves its navigation behavior', () => {
  const header = read('components/tm-header/tm-header.uvue');
  const register = read('pages/register/index.uvue');
  const login = read('pages/login/index.uvue');

  assert.match(header, /<view[^>]+class=["']header-control["'][^>]*>[\s\S]*?<text[^>]*>返回<\/text>[\s\S]*?<button[^>]+aria-label=["']返回上一页["'][^>]+@click=["']goBack["'][^>]*><\/button>/);
  assert.doesNotMatch(header, /class=["']back-icon["']|iconfont|uni-icons|::before|::after|(?:^|\n)\s*content\s*:/i);
  assert.doesNotMatch(header, /[\uE000-\uF8FF]/u);
  assert.match(header, /const goBack\s*=\s*\(\)\s*=>\s*\{[\s\S]*uni\.navigateBack\(\{[\s\S]*fail:[\s\S]*uni\.reLaunch\(\{\s*url:\s*['"]\/pages\/dashboard\/index['"]\s*\}\)/);
  assert.match(header, /\.header-control\s*\{[\s\S]*border-color:\s*\$tm-line[\s\S]*background-color:\s*\$tm-surface-1/);
  assert.match(register, /<tm-header title=["']创建账户["'] :back=["']true["'] \/>/);
  assert.match(login, /<tm-header title=["']登录["'] :back=["']true["'] \/>/);
});

test('Phase 1 account, task status, privacy, and list interaction contracts are explicit', () => {
  const models = read('types/models.uts');
  const login = read('pages/login/index.uvue');
  const register = read('pages/register/index.uvue');
  const presentation = read('services/presentation.uts');
  const tasks = read('pages/tasks/index.uvue');
  const permission = read('pages/permission/index.uvue');

  assert.match(login, />用户名</);
  assert.match(register, />用户名</);
  assert.doesNotMatch(`${login}\n${register}`, /邮箱|email/i);
  assert.match(models, /'not_requested' \| 'pending' \| 'sending' \| 'submitted' \| 'failed' \| 'unknown' \| 'skipped_disabled' \| 'skipped_no_target'/);
  assert.doesNotMatch(models, /'sent'|'skipped_permission'/);
  assert.match(models, /TaskDeliveryFilter\s*=\s*'all' \| 'not_requested'/);
  assert.match(presentation, /case 'submitted'/);
  assert.match(presentation, /未发送通知/);
  assert.match(presentation, /推送服务已接受发送请求/);
  assert.match(tasks, /refresher-enabled/);
  assert.match(tasks, /desktopOptions/);
  assert.match(tasks, /deliveryFilters/);
  assert.match(permission, /privacyConfirmed/);
});

test('authenticated onboarding reports local facts and backend facts without guessing', () => {
  const permission = read('pages/permission/index.uvue');
  const service = read('services/tokenm-service.uts');
  const client = read('services/client.uts');

  assert.match(permission, /getClientBootstrapStatus/);
  assert.match(permission, /loginFactView\(facts\.login\)/);
  assert.match(permission, /privacyVersionLabel/);
  assert.match(permission, /permissionView\(facts\.notificationPermission\)/);
  assert.match(permission, /activeDesktopCountLabel/);
  assert.match(permission, /notificationsEnabledLabel/);
  assert.match(permission, /bootstrapStatus\.backend\s*==\s*['"]unavailable['"]/);
  assert.match(permission, /无法核对电脑绑定数量和任务通知设置/);
  assert.match(permission, /绑定电脑/);
  assert.match(permission, /查看电脑/);
  assert.match(permission, /进入 App/);
  assert.match(service, /tokenmCo\.bootstrap<CloudBootstrapResult>\s*\(\{\}\)/);
  assert.match(service, /activeDesktopCount:\s*result\.counts\.activeDesktops/);
  assert.match(service, /notificationsEnabled:\s*result\.user\.notificationsEnabled/);
  assert.match(client, /getClientBootstrapStatus/);
});

test('App stays outside push/cloud calls and the client facade selects the real Token M service', () => {
  const app = read('App.uvue');
  const client = read('services/client.uts');

  assert.doesNotMatch(app, /getPushClientId|onPushMessage|requestSystemPermission|POST_NOTIFICATIONS|uniCloud/);
  assert.match(client, /tokenm-service/);
  assert.doesNotMatch(client, /mock-service/);
});

test('register/login captcha ownership is single-load, explicit-refresh, and failure-visible', () => {
  const auth = read('services/auth-service.uts');
  const pages = [
    { source: read('pages/register/index.uvue'), scene: 'register' },
    { source: read('pages/login/index.uvue'), scene: 'login-by-pwd' }
  ];

  assert.doesNotMatch(auth, /uniCaptchaCo|uni-captcha-co/);
  assert.match(auth, /const mapCaptchaResult[\s\S]{0,400}getString\(\s*['"]captchaBase64['"]\s*\)/);
  assert.match(auth, /const SVG_BASE64_PREFIX\s*=\s*['"]data:image\/svg\+xml;base64,/);
  assert.match(auth, /const decodeSvgUriPayload[\s\S]{0,1200}decodeURIComponent\(\s*encodedRun\s*\)/);
  assert.doesNotMatch(auth, /\.split\(\s*['"]%23['"]\s*\)/);
  assert.doesNotMatch(auth, /decodeURIComponent\(\s*value(?:\.substring)?/);
  assert.match(auth, /const normalizeCaptchaUri[\s\S]{0,700}hasSvgRoot[\s\S]{0,400}SVG_BASE64_PREFIX/);
  assert.match(auth, /new TextEncoder\(\)\.encode\(\s*svgText\s*\)/);
  assert.match(auth, /const arrayBuffer = new ArrayBuffer\(\s*bytes\.length\s*\)/);
  assert.match(auth, /const target = new Uint8Array\(\s*arrayBuffer\s*\)/);
  assert.match(auth, /target\.set\(\s*bytes\s*\)/);
  assert.match(auth, /uni\.arrayBufferToBase64\(\s*arrayBuffer\s*\)/);
  assert.match(auth, /uniIdCo\.createCaptcha\(\s*\{\s*scene\s*\}\s*\)/);
  assert.match(auth, /uniIdCo\.refreshCaptcha\(\s*\{\s*scene\s*\}\s*\)/);
  assert.match(auth, /rawCaptchaBase64\s*==\s*null[\s\S]{0,120}rawCaptchaBase64\.length\s*==\s*0/);
  assert.match(auth, /console\.info\(\s*['"]\[captcha\] create start['"]/);
  assert.match(auth, /console\.info\(\s*['"]\[captcha\] refresh start['"]/);
  assert.match(auth, /console\.info\(\s*['"]\[captcha\] create success['"]/);
  assert.match(auth, /console\.info\(\s*['"]\[captcha\] refresh success['"]/);
  assert.match(auth, /console\.warn\(\s*['"]\[captcha\] create failure['"]/);
  assert.match(auth, /console\.warn\(\s*['"]\[captcha\] refresh failure['"]/);
  const logLines = auth.split('\n')
    .filter((line) => /console\.(?:info|warn|error|log)/.test(line) && line.includes('[captcha]'))
    .join('\n');
  assert.doesNotMatch(logLines, /captchaBase64|payload|password|token|secret|code/i);

  for (const { source, scene } of pages) {
    assert.equal(occurrenceCount(source, /\bonLoad\s*\(/g), 1);
    assert.equal(occurrenceCount(source, /\bonShow\s*\(/g), 0);
    assert.doesNotMatch(source, /\b(?:mounted|watch)\s*\(/);
    assert.equal(occurrenceCount(source, /\bcreateCaptcha\s*\(/g), 1);
    assert.equal(occurrenceCount(source, /\brefreshCaptcha\s*\(/g), 1);
    assert.match(source, new RegExp(`captchaCreated\\s*\\?\\s*await refreshCaptcha\\(\\s*['"]${scene}['"]\\s*\\)\\s*:\\s*await createCaptcha\\(\\s*['"]${scene}['"]\\s*\\)`));
    assert.match(source, /<view[^>]+class=["']captcha-refresh["'][^>]*>[\s\S]*?<image/);
    assert.doesNotMatch(source, /<button[^>]+class=["']captcha-refresh["']/);
    assert.match(source, /mode=["']widthFix["']/);
    assert.match(source, /@load=["']captchaImageLoad["']/);
    assert.match(source, /@error=["']captchaImageError["']/);
    assert.match(source, /验证码加载失败，点击重试/);

    const submitStart = source.indexOf('const runSubmit');
    const submitEnd = source.indexOf('const submit', submitStart);
    assert.notEqual(submitStart, -1);
    assert.notEqual(submitEnd, -1);
    const submitSource = source.slice(submitStart, submitEnd);
    if (scene === 'register') {
      const registerCall = submitSource.indexOf('await registerWithUsername');
      const conditionalReload = submitSource.indexOf('registrationCaptchaShouldReload', registerCall);
      assert.ok(registerCall >= 0);
      assert.ok(conditionalReload > registerCall);
      assert.equal(occurrenceCount(submitSource, /await runReloadCaptcha\(\)/g), 1);
    } else {
      const conditionalReload = submitSource.indexOf('registrationCaptchaShouldReload');
      assert.equal(conditionalReload, -1);
      assert.doesNotMatch(submitSource, /runReloadCaptcha/);
    }

    const imageError = source.match(/const captchaImageError\s*=\s*\(event:\s*UniImageErrorEvent\)\s*=>\s*\{([\s\S]*?)\n\}/);
    assert.ok(imageError);
    assert.doesNotMatch(imageError[1], /runReloadCaptcha/);
  }
});
