/**
 * ACL constants — pure re-export from src/utils/constants.js.
 * All constants live in one place; this module exists so existing
 * require('./constants') calls in src/acl/ still work.
 */
module.exports = require('../utils/constants.js');
