/**
 * Reading the names inside a zip without unpacking it.
 *
 * Every extractor this app can reach — bsdtar, GNU tar, unzip, PowerShell's
 * `Expand-Archive` — takes the entry names on trust and will happily write to
 * `..\..\Windows\System32` if an archive asks it to. We hand one of them an
 * archive fetched over the network, so the names are read here first and the
 * unpack is refused if any of them leads outside the target directory.
 *
 * Only the central directory is read: entry names live there, at a known offset
 * at the end of the file, so this costs two short reads rather than a download's
 * worth of memory.
 */
import { open } from 'node:fs/promises';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** The comment at the end of a zip may be up to 64 KB; the record is 22 bytes. */
const EOCD_SEARCH = 65_557;

/**
 * Would unpacking this entry write outside the directory it is unpacked into?
 *
 * Absolute paths, drive letters and any `..` segment are all refusals. Backslash
 * counts as a separator even though the format says forward slash: Windows
 * extractors honour both, so an entry named `..\..\evil` escapes on the one
 * platform where it matters most.
 */
export function unsafeEntry(name) {
  const value = String(name ?? '');
  if (!value) return false;
  if (/^[/\\]/.test(value) || /^[A-Za-z]:/.test(value)) return true;
  return value.split(/[/\\]/).some((segment) => segment === '..');
}

/** Every entry name in the archive, in the order the central directory lists them. */
export async function zipEntryNames(path) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const tailSize = Math.min(size, EOCD_SEARCH);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error('not a zip archive (no end-of-central-directory record)');

    const count = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    // 0xFFFFFFFF is zip64's "look in the zip64 record instead". Nothing this
    // app downloads is that big, and guessing at names we cannot read would be
    // worse than saying so.
    if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
      throw new Error('zip64 archives are not read here');
    }

    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    const names = [];
    let at = 0;
    for (let i = 0; i < count; i += 1) {
      if (at + 46 > directory.length) throw new Error('central directory ends mid-entry');
      if (directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new Error('central directory is malformed');
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      names.push(directory.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
      at += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Throw unless every entry stays inside the directory it would be unpacked to.
 *
 * An archive whose directory cannot be read is refused as well: this runs on a
 * file we just fetched from the network, and "could not check" is not a reason
 * to hand it to an extractor anyway.
 */
export async function assertSafeArchive(path) {
  let names;
  try {
    names = await zipEntryNames(path);
  } catch (err) {
    throw new Error(`could not check what is inside the archive (${err.message})`);
  }
  const escaping = names.filter(unsafeEntry);
  if (escaping.length > 0) {
    throw new Error(`the archive would write outside the tools folder (${escaping[0]}) — refusing to unpack it`);
  }
  return names;
}
