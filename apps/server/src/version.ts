/** Application version: KADAI_VERSION (set by the release build / container) or package.json. */
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = process.env.KADAI_VERSION ?? pkg.version
