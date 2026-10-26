import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join, relative, isAbsolute } from 'path';
import { randomUUID } from 'crypto';

// When SherlockMail is launched by another MSIX-packaged app (for example a desktop assistant's tool
// runner), Windows silently redirects AppData writes into that app's private package cache
// (%LOCALAPPDATA%\Packages\<pkg>\LocalCache\Roaming\...). Evidence and the case database would then
// land in a hidden folder that is deleted if that app is reset or uninstalled. Detect it by writing a
// probe file and looking for it under the package caches.
export function detectRedirectedAppData(userDataDir) {
  const { APPDATA, LOCALAPPDATA } = process.env;
  if (process.platform !== 'win32' || !APPDATA || !LOCALAPPDATA) return null;
  const rel = relative(APPDATA, userDataDir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;

  const probeName = `.appdata-probe-${randomUUID()}`;
  const probe = join(userDataDir, probeName);
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(probe, '');
  } catch {
    return null;
  }
  try {
    const packagesDir = join(LOCALAPPDATA, 'Packages');
    for (const pkg of readdirSync(packagesDir)) {
      const redirectedDir = join(packagesDir, pkg, 'LocalCache', 'Roaming', rel);
      try {
        if (existsSync(join(redirectedDir, probeName))) return { packageName: pkg, redirectedDir };
      } catch {
        // Other packages' caches may be unreadable; they cannot be the redirect target.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try { unlinkSync(probe); } catch {}
  }
}
