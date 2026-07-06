/**
 * Compatibility barrel — re-exports everything from the grouped sub-modules.
 * Existing `import { ... } from '../utils/constants'` and
 * `require('./constants')` calls continue to work unchanged.
 */
export * from './timing.js';
export * from './fields.js';
export * from './aviation.js';
export * from './airlines.js';
export * from './acl-format.js';
export * from './map-config.js';
export * from './ui.js';
