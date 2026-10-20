'use strict';

// Compatibility import for status consumers. Independent npm replacement and
// cache cleanup are retired; legacy pointers and standalone binaries are untouched.
const { getTokscaleStatus } = require('./collector');

module.exports = { getTokscaleStatus };
