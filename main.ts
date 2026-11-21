// GTA 6 Clipper — make.fun entry program (gta6-clipper-01).
//
// The entry itself is a public YouTube clip; this program has exactly one
// job for the grader: hand over the clip's address. It copies VIDEO.json
// from the repository directory (MAKEFUN_BOT_DIR, default /bot) into the
// output directory (MAKEFUN_OUTPUT_DIR, default /output), byte for byte.
// No network, no clock, no other files are touched, so two runs always
// produce identical output.
//
// Local check:
//   mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const sourceDir = process.env.MAKEFUN_BOT_DIR || '/bot';
const targetDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const sourceFile = join(sourceDir, 'VIDEO.json');
const targetFile = join(targetDir, 'VIDEO.json');

// Fail loudly rather than hand in nothing: a missing VIDEO.json means the
// entry has no video address at all, and the gate would refuse it anyway.
if (!existsSync(sourceFile)) {
  console.error(`error: VIDEO.json not found in ${sourceDir} — nothing to hand in`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(sourceFile, targetFile);
