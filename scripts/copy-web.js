// Copies the static dashboard files next to the compiled scripts. tsc only
// emits JavaScript, so the page and stylesheet have to be placed by hand.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'web');
const target = join(root, 'dist', 'web');

await mkdir(target, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  await copyFile(join(source, file), join(target, file));
}
