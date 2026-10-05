import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Resolve an asset only if the file it actually names stays inside its root. */
export function containedFile(root, path) {
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(join(realRoot, path));
    const inside = relative(realRoot, realTarget);
    return inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
      ? realTarget
      : null;
  } catch {
    return null;
  }
}
