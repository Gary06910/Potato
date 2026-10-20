'use strict';
const fs = require('node:fs');
const path = require('node:path');

// --home alone does not override fork-native APPDATA sources on Windows.
// Keep every probe source and cache inside its empty synthetic profile.
function isolatedProbeEnv(home, inherited = process.env) {
  const config = path.join(home, '.config', 'tokscale');
  const env = { ...inherited };
  const excluded = new Set(['TOKSCALE_EXTRA_DIRS', 'GOOSE_PATH_ROOT', 'HERMES_HOME', 'DSH_HOME',
    'TOKEN_MONITOR_QODER_CN_DB_PATH', 'TOKEN_MONITOR_QODER_CN_PROJECTS_PATH', 'QODERCN_CONFIG_DIR',
    'MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR', 'TOKSCALE_HEADLESS_DIR', 'NO_PROXY']);
  for (const key of Object.keys(env)) if (excluded.has(key.toUpperCase())) delete env[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    TOKSCALE_CONFIG_DIR: config, TOKSCALE_PRICING_CACHE_ONLY: '1',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9'
  });
  const cache = path.join(config, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  for (const name of ['litellm', 'openrouter', 'models-dev']) fs.writeFileSync(path.join(cache, 'pricing-' + name + '.json'), JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), data: {} }));
  return env;
}
module.exports = { isolatedProbeEnv };
