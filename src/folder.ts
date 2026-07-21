import { readdir, lstat, open, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { LIMITS, ReviewError } from './types.ts';
const ignoredDirs = new Set(['.git','.hg','.svn','node_modules','vendor','dist','build','out','coverage','.next','.nuxt','target','bin','obj','.venv','venv','__pycache__']);
const summaryReserve = 512;
function excludedName(name: string) { return /^\.env(?:\.|$)|^\.npmrc$|^\.pypirc$|^\.netrc$|^credentials\.json$|\.(pem|key|p12|pfx|jks|keystore)$/i.test(name) || /^(id_rsa|id_ed25519|id_dsa|id_ecdsa)$/i.test(name) || /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(name) || /\.min\.[^.]+$/i.test(name); }
async function boundedText(path: string) {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(LIMITS.repoFile + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const oversized = bytesRead > LIMITS.repoFile;
    const data = bytes.subarray(0, Math.min(bytesRead, LIMITS.repoFile));
    if (data.includes(0)) return undefined;
    for (let end = data.length; end >= Math.max(0, data.length - 4); end--) {
      try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, end)), truncated: oversized }; } catch {}
    }
    return undefined;
  } finally { await handle.close(); }
}
export async function collectFolder(cwd: string) {
  const root = await realpath(cwd); let included = 0, excluded = 0, visited = 0, truncated = false, total = 0, stopped = false; const sections: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (stopped) return;
    if (depth > LIMITS.repoDepth) { excluded++; truncated = true; return; }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (stopped) return;
      visited++;
      if (visited > LIMITS.repoEntries) { truncated = true; stopped = true; return; }
      const path = join(dir, entry.name); const info = await lstat(path);
      if (info.isSymbolicLink()) { excluded++; continue; }
      if (info.isDirectory()) { if (ignoredDirs.has(entry.name.toLowerCase())) { excluded++; continue; } await walk(path, depth + 1); continue; }
      if (!info.isFile() || excludedName(entry.name)) { excluded++; continue; }
      const file = await boundedText(path);
      if (file === undefined) { excluded++; truncated ||= info.size > LIMITS.repoFile; continue; }
      const text = file.truncated ? `${file.text}\n[TRUNCATED: file byte limit]` : file.text;
      truncated ||= file.truncated;
      const section = `\n## ${relative(root, path).split(sep).join('/')}\n\n${text}\n`;
      if (total + Buffer.byteLength(section) > LIMITS.repoSnapshot - summaryReserve) { truncated = true; stopped = true; return; }
      sections.push(section); total += Buffer.byteLength(section); included++;
    }
  }
  await walk(root, 0);
  if (!included) throw new ReviewError('NO_REVIEWABLE_CONTENT', 'No eligible text files were found in the current folder.');
  const artifact = `# Bounded folder snapshot\n\nIncluded files: ${included}\nExcluded files: ${excluded}\nTruncated: ${truncated ? 'yes' : 'no'}\n${sections.join('')}`;
  if (Buffer.byteLength(artifact) > LIMITS.repoSnapshot) throw new ReviewError('BUNDLE_CREATION_FAILED', 'Folder snapshot exceeded its safe size limit.');
  return { root, artifact, truncated, includedFiles: included, excludedFiles: excluded };
}
