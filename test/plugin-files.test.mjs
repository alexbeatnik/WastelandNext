import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containedFile } from '../src/main/plugins/files.mjs';

test('plugin assets stay inside their real directory, including through links', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wl-plugin-files-'));
  const plugin = join(root, 'plugin');
  mkdirSync(plugin);
  writeFileSync(join(plugin, 'theme.css'), 'body {}');
  writeFileSync(join(root, 'private.txt'), 'private');
  assert.equal(containedFile(plugin, 'theme.css'), join(plugin, 'theme.css'));
  assert.equal(containedFile(plugin, '../private.txt'), null);

  try {
    symlinkSync(join(root, 'private.txt'), join(plugin, 'link.txt'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.diagnostic('symbolic links unavailable on this host');
    throw error;
  }
  assert.equal(containedFile(plugin, 'link.txt'), null);
});
