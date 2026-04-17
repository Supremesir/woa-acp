'use strict';
//
// MCP SDK Request Timeout Hook
//
// The MCP SDK has a hardcoded 60s default request timeout.
// This preload script patches it at load time to use a configurable value.
//
// Usage: node --require ./mcp-timeout-hook.cjs ./wps-feedback-server.cjs
//
// Environment variable:
//   MCP_REQUEST_TIMEOUT_MS  — timeout in milliseconds (default: 600000 = 10 min)
//

const Module = require('module');
const origCompile = Module.prototype._compile;

const timeoutMs = parseInt(process.env.MCP_REQUEST_TIMEOUT_MS, 10) || 600000;

Module.prototype._compile = function (content, filename) {
  if (content.includes('_setupTimeout') && content.includes('Request timed out')) {
    content = content.replace(
      /void 0!==(\w)\?\1:6e4;this\._setupTimeout/g,
      `void 0!==$1?$1:${timeoutMs};this._setupTimeout`
    );
  }
  return origCompile.call(this, content, filename);
};
