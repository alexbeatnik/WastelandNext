/**
 * Finding models without leaving the app.
 *
 * Two HuggingFace endpoints, both public and unauthenticated: a model search
 * filtered to GGUF repositories, and a file tree per repository so a
 * quantisation can be chosen by its real size rather than by guessing from its
 * name. Nothing here downloads — the resulting URL goes through the same
 * downloader as a hand-pasted one.
 */
import { basename } from 'node:path';

const API = 'https://huggingface.co/api';
const TIMEOUT_MS = 15_000;

/**
 * Quantisations from smallest to largest, which is also roughly worst to best.
 *
 * Used to order a repository's files so the list reads as a quality ladder
 * instead of alphabetical noise. Anything unrecognised sorts to the end.
 */
const QUANT_ORDER = [
  'IQ1_S', 'IQ1_M',
  'IQ2_XXS', 'IQ2_XS', 'IQ2_S', 'IQ2_M', 'Q2_K_S', 'Q2_K',
  'IQ3_XXS', 'IQ3_XS', 'IQ3_S', 'IQ3_M', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L',
  'IQ4_XS', 'IQ4_NL', 'Q4_0', 'Q4_1', 'Q4_K_S', 'Q4_K_M',
  'Q5_0', 'Q5_1', 'Q5_K_S', 'Q5_K_M',
  'Q6_K',
  'Q8_0',
  'F16', 'BF16', 'F32',
];

/** The quantisation named in a GGUF filename, uppercased, or ''. */
export function parseQuant(filename) {
  const name = basename(String(filename ?? '')).replace(/\.gguf$/i, '');
  // Longest match wins so `Q4_K_M` is not reported as `Q4_K` — the list is
  // walked from the most specific end.
  const byLength = [...QUANT_ORDER].sort((a, b) => b.length - a.length);
  const hit = byLength.find((quant) => new RegExp(`(^|[-_.])${quant}([-_.]|$)`, 'i').test(name));
  return hit ?? '';
}

/** Multi-part shards need every piece; one download cannot assemble them. */
export function isShard(filename) {
  return /-\d{5}-of-\d{5}\.gguf$/i.test(String(filename ?? ''));
}

/** The download URL for one file in a repository. */
export function downloadUrlFor(repoId, path) {
  return `https://huggingface.co/${repoId}/resolve/main/${encodeURI(path)}`;
}

async function getJson(url, signal) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HuggingFace says ${res.status}`);
  return res.json();
}

/**
 * Shape one search hit into what the list needs.
 *
 * The API returns a great deal more than this; carrying only what is displayed
 * keeps the IPC payload small and the renderer honest about what it has.
 */
export function toResult(entry) {
  const tags = entry.tags ?? [];
  return {
    id: entry.id ?? entry.modelId ?? '',
    downloads: Number(entry.downloads) || 0,
    likes: Number(entry.likes) || 0,
    updated: entry.lastModified ?? entry.createdAt ?? '',
    gated: Boolean(entry.gated),
    // A visible hint of what the thing is, without dumping thirty tags.
    languages: tags.filter((t) => /^[a-z]{2}$/.test(t)).slice(0, 4),
  };
}

/**
 * Search GGUF repositories.
 *
 * Sorted by downloads because popularity is the best available proxy for "this
 * one actually works" — a broken quantisation does not get downloaded twice.
 */
export async function searchModels({ query, limit = 20, signal } = {}) {
  const term = String(query ?? '').trim();
  if (!term) return [];

  const url =
    `${API}/models?search=${encodeURIComponent(term)}` +
    `&filter=gguf&sort=downloads&direction=-1&limit=${Math.min(50, Math.max(1, limit))}`;

  const entries = await getJson(url, signal);
  return (Array.isArray(entries) ? entries : []).map(toResult).filter((r) => r.id);
}

/** Order a repository's files as a quality ladder, cheapest first. */
export function sortGgufFiles(files) {
  return [...files].sort((a, b) => {
    const rank = (file) => {
      const index = QUANT_ORDER.indexOf(file.quant);
      return index === -1 ? QUANT_ORDER.length : index;
    };
    return rank(a) - rank(b) || a.size - b.size || a.name.localeCompare(b.name);
  });
}

/**
 * The GGUF files in a repository, with real sizes.
 *
 * Shards are listed but flagged, rather than hidden: a user looking for a 70B
 * should see that the files exist and understand why they are not offered.
 */
export async function listGgufFiles(repoId, { signal } = {}) {
  const id = String(repoId ?? '').trim();
  if (!id) throw new Error('no repository given');

  const entries = await getJson(`${API}/models/${id}/tree/main?recursive=true`, signal);
  const files = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry.type === 'file' && /\.gguf$/i.test(entry.path ?? ''))
    .map((entry) => ({
      path: entry.path,
      name: basename(entry.path),
      // LFS files report the real size in the nested record; `size` on the
      // outer entry can be the pointer file's size instead.
      size: Number(entry.lfs?.size ?? entry.size) || 0,
      quant: parseQuant(entry.path),
      shard: isShard(entry.path),
      url: downloadUrlFor(id, entry.path),
    }));

  return sortGgufFiles(files);
}
