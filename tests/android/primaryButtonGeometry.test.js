'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../../apps/tokenm-android');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('shared surfaces retain geometry while independent label layers own centering', () => {
  const app = read('App.uvue');
  const surface = app.match(/\.primary-surface, \.secondary-surface, \.danger-surface\s*\{([^}]+)\}/)?.[1];
  const primary = app.match(/\.primary-surface\s*\{([^}]+)\}/)?.[1];
  const label = app.match(/\.button-label-layer\s*\{([^}]+)\}/)?.[1];
  const hitbox = app.match(/\.button-hitbox\s*\{([^}]+)\}/)?.[1];
  assert.ok(surface && primary && label && hitbox);
  for (const style of [/position:\s*relative/, /width:\s*100%/, /height:\s*\$tm-touch/, /border-radius:\s*\$tm-radius-md/, /overflow:\s*hidden/]) assert.match(surface, style);
  for (const style of [/background-color:\s*\$tm-accent/, /box-shadow:/]) assert.match(primary, style);
  for (const style of [/box-sizing:\s*border-box/, /width:\s*100%/, /height:\s*100%/, /align-items:\s*center/, /justify-content:\s*center/]) assert.match(label, style);
  for (const style of [/position:\s*absolute/, /width:\s*100%/, /height:\s*100%/, /background-color:\s*transparent/, /box-shadow:\s*none/]) assert.match(hitbox, style);
  assert.doesNotMatch(label, /line-height|margin-top|padding-top/);
  assert.match(app, /\.primary-surface-active\s*\{\s*background-color:\s*\$tm-accent-pressed;/);
  assert.match(app, /\.primary-surface-disabled\.primary-surface-active\s*\{\s*background-color:\s*#e9eef5;/);
  assert.match(app, /\.button-surface-active\s*\{\s*opacity:\s*0\.9;/);
});

test('standard primary and outline actions render text outside the native button', () => {
  const pages = ['onboarding', 'login', 'register', 'desktops', 'notifications', 'permission', 'pairing', 'settings', 'dashboard', 'privacy', 'background-protection'];
  for (const name of pages) {
    const source = read(`pages/${name}/index.uvue`);
    assert.match(source, /class="primary-surface[^"]*"[^>]*>[\s\S]*?<view class="button-label-layer"><text class="button-label/);
    assert.match(source, /<button class="button-hitbox"[^>]*><\/button>/);
    assert.doesNotMatch(source, /<button[^>]*(?:primary-hitbox|btn-primary|btn-secondary)[^>]*>/);
  }
  for (const name of ['onboarding', 'pairing', 'permission', 'background-protection']) {
    assert.match(read(`pages/${name}/index.uvue`), /class="secondary-surface[^"]*"[^>]*><view class="button-label-layer"><text class="button-label/);
  }
  const desktops = read('pages/desktops/index.uvue');
  assert.match(desktops, /class="primary-surface section"[^>]*>[\s\S]*?<text class="button-label">绑定另一台电脑<\/text>/);
  assert.match(read('pages/login/index.uvue'), /<text class="button-label">\{\{ submitting \? '正在登录…' : '登录' \}\}<\/text>[\s\S]*?<button class="button-hitbox" :disabled="submitting"/);
});

test('reported compact actions and task filters use centered text layers', () => {
  const header = read('components/tm-header/tm-header.uvue');
  const dashboard = read('pages/dashboard/index.uvue');
  const tasks = read('pages/tasks/index.uvue');
  const app = read('App.uvue');
  assert.match(header, /<text class="compact-label">\{\{ actionText \}\}<\/text>[\s\S]*?<button class="button-hitbox"/);
  assert.match(dashboard, /<text class="compact-label">查看全部<\/text>[\s\S]*?<button class="button-hitbox"/);
  assert.match(tasks, /<view class="filter-chip-label-layer"><text class="filter-chip-label">\{\{ item.label \}\}<\/text><\/view><button class="button-hitbox"/);
  assert.match(app, /\.compact-label-layer\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center/);
  assert.doesNotMatch(header, /<button[^>]*>(?:设置|添加|\{\{ actionText \}\})<\/button>/);
  assert.doesNotMatch(dashboard, /<button[^>]*>查看全部<\/button>/);
});
