// Makes ClipperLib available in Node (the browser loads it with a script tag).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.ClipperLib ??= require('clipper-lib');
