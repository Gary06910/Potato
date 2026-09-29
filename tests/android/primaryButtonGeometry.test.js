'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../../apps/tokenm-android');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the shared view owns primary color, radius, clipping, and shadow', () => {
  const app = read('App.uvue');
  const surface = app.match(/\.primary-surface\s*\{([^}]+)\}/)?.[1];
  const hitbox = app.match(/\.primary-hitbox\s*\{([^}]+)\}/)?.[1];
  assert.ok(surface);
  assert.ok(hitbox);
  for (const style of [/width:\s*100%/, /min-height:\s*\$tm-touch/, /border-radius:\s*\$tm-radius-md/, /background-color:\s*\$tm-accent/, /overflow:\s*hidden/, /box-shadow:/]) assert.match(surface, style);
  for (const style of [/width:\s*100%/, /min-height:\s*\$tm-touch/, /border-radius:\s*0/, /background-color:\s*transparent/, /box-shadow:\s*none/]) assert.match(hitbox, style);
  assert.doesNotMatch(app, /\.btn-primary\s*\{/);
});

test('all app owned primary actions use the shared surface and transparent hitbox', () => {
  const pages = ['onboarding', 'login', 'register', 'desktops', 'notifications', 'permission', 'pairing', 'settings', 'dashboard', 'privacy', 'background-protection'];
  for (const name of pages) {
    const source = read(`pages/${name}/index.uvue`);
    assert.match(source, /<view[^>]+class="primary-surface[^"]*"[^>]*>[\s\S]*?<button class="btn primary-hitbox"/);
    assert.doesNotMatch(source, /<button[^>]+btn-primary/);
    assert.doesNotMatch(source, /<button[^>]+background-color:\s*\$tm-accent/);
  }
  const desktops = read('pages/desktops/index.uvue');
  assert.match(desktops, /class="primary-surface section"[\s\S]*?绑定另一台电脑/);
});
