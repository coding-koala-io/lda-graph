import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {product} from '../src/product.js';

export function releaseNotes(changelog, version) {
  const sections = changelog.split(/(?=^## \[)/m);
  const section = sections.find(value => value.startsWith(`## [${version}]`));
  if (!section) throw new Error(`Missing CHANGELOG section for ${version}`);
  // A release must carry its date; "unreleased" or an undated heading blocks publishing.
  const heading = section.split(/\r?\n/, 1)[0].trim();
  if (/unreleased/i.test(heading) || !new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] - \\d{4}-\\d{2}-\\d{2}$`).test(heading)) {
    throw new Error(`CHANGELOG section for ${version} is not dated ("${heading}"). Change its heading to "## [${version}] - YYYY-MM-DD" before releasing.`);
  }
  return section.trim() + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { writeFileSync('release-notes.md', releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), product.version)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
