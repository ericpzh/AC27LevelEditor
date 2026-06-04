/**
 * Preload — transpiles ESM import/export in src/ files so tests
 * can require() them without Node choking on import syntax.
 *
 * Usage: node --require ./test/preload.cjs test/test_parse_airport.js
 */

const Module = require('module');

// ── 1. Extensionless CJS resolution ──
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req.startsWith('.') && !req.match(/\.(js|json|node|mjs|cjs)$/)) {
    try { return origResolve.call(this, req + '.js', parent, ...rest); } catch (_) {}
    try { return origResolve.call(this, req + '/index.js', parent, ...rest); } catch (__) {}
  }
  return origResolve.call(this, req, parent, ...rest);
};

// ── 2. ESM→CJS transform for src/ files ──
const origCompile = Module.prototype._compile;
Module.prototype._compile = function (code, filename) {
  if (/[\\/]src[\\/]/.test(filename) && /\b(import|export)\b/.test(code)) {

    // Collect export names for later appending
    const exportNames = [];

    code = code
      // import { a, b } from 'x'  (single or multi-line)
      .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm,
        (_, names, src) => `const { ${names.replace(/[\r\n]/g, '').replace(/\s+/g, ' ').trim()} } = require('${src}');`)

      // export { a, b } from 'x'
      .replace(/^export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm,
        (_, names, src) => {
          const vars = names.replace(/[\r\n]/g, '').replace(/\s+/g, ' ').trim()
            .split(',').map(s => s.trim()).filter(Boolean);
          return `const { ${vars.join(', ')} } = require('${src}');\n` +
            vars.map(v => `module.exports.${v} = ${v};`).join('\n');
        })

      // export { a, b }
      .replace(/^export\s*\{([^}]+)\};?\s*$/gm,
        (_, names) => {
          const vars = names.replace(/[\r\n]/g, '').replace(/\s+/g, ' ').trim()
            .split(',').map(s => s.trim()).filter(Boolean);
          return vars.map(v => `module.exports.${v} = ${v};`).join('\n');
        })

      // export const / let / var name = ...  (strip export keyword, export at end)
      .replace(/^export\s+(const|let|var)\s+(\w+)\s*=/gm,
        (_, kind, name) => {
          exportNames.push(name);
          return `${kind} ${name} =`;
        })

      // export function name(params)
      .replace(/^export\s+function\s+(\w+)\s*\(/gm,
        (_, name) => {
          exportNames.push(name);
          return `function ${name}(`;
        })

      // export default function name(...)  →  keep function, export as default
      .replace(/^export\s+default\s+function\s+(\w+)\s*\(/gm,
        (_, name) => {
          exportNames.push('default');
          return `function ${name}(`;
        });

    // Append module.exports for export function / export const that
    // weren't already handled by inline module.exports.X = X patterns
    if (exportNames.length > 0) {
      code += '\n' + exportNames.map(n => `module.exports.${n} = ${n};`).join('\n') + '\n';
    }
  }
  return origCompile.call(this, code, filename);
};
