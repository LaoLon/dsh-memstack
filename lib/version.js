/** Single source for the package version used in bundles, health and the CLI. */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
export const APP_VERSION = require('../package.json').version
