// Where the app keeps what belongs to this PC: tools, settings, remnants, jobs,
// Onshape keys. Run from a folder (npm start) it's ./data, as always; the
// desktop app points CABINET_CAM_DATA at the user's app-data folder, so
// installing an update never touches it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.CABINET_CAM_DATA ? path.resolve(process.env.CABINET_CAM_DATA) : path.join(root, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
export const dataPath = (...p) => path.join(DATA_DIR, ...p);
