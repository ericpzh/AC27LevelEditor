/**
 * Compatibility barrel — re-exports everything from the grouped sub-modules.
 *
 * Existing `import { ... } from '../utils/constants'` and
 * `require('./constants')` calls continue to work unchanged.
 *
 * New code should import directly from the specific sub-module:
 *   import { FIELDS, getActiveColumns } from '../utils/constants/fields.js';
 *   import { CACHE_VERSION } from '../utils/constants/timing.js';
 */
export * from './constants/timing.js';
export * from './constants/fields.js';
export * from './constants/aviation.js';
export * from './constants/airlines.js';
export * from './constants/acl-format.js';
export * from './constants/map-config.js';
export * from './constants/ui.js';
