'use strict';
const { createHash } = require('node:crypto');
const { clientSourceRoots } = require('./clientSources');
const { normalizeClientsCsv, PARSE_LOCAL_CLIENTS } = require('./clientTracking');
// Only definitions and discovered source sets belong here. File size/mtime would
// invalidate every append and defeat targeted today deltas.
function sourceRegistryFingerprint(clients, options = {}) {
  if (options.sourceRevision !== undefined) return options.sourceRevision;
  const csv = normalizeClientsCsv(clients);
  const inputs = { roots: clientSourceRoots(csv, options), ownership: PARSE_LOCAL_CLIENTS,
    extraDirs: (options.env || process.env).TOKSCALE_EXTRA_DIRS || '' };
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}
module.exports = { sourceRegistryFingerprint };
