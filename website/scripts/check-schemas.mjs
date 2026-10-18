#!/usr/bin/env node
/**
 * Every documentation page must carry its own structured data.
 *
 * This block has vanished twice without a word: once because a JSON string
 * carried through YAML frontmatter came out corrupted, and once because the
 * lookup key kept the numeric prefix that Docusaurus strips from document ids.
 * Both builds succeeded. The pages simply rendered nothing, and nothing said
 * so — which is the same way the endpoint count went stale for a year.
 *
 * Run after `docusaurus build`, against the built HTML rather than the source,
 * because what matters is what a crawler receives.
 *
 * Usage:  node scripts/check-schemas.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const websiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(websiteRoot, 'build');

/** Pages that are not documentation and carry no page-level schema. */
const EXEMPT = new Set([
  '404.html',
  'google423b64df285275ff.html',
  'changelog.html',
  // The blog index is a listing; its posts are checked below, one by one.
  'blog.html',
]);

/** Blog listing pages, which are indexes rather than articles. */
const BLOG_EXEMPT = new Set(['archive.html', 'authors.html', 'tags.html', 'index.html']);

const REQUIRED = ['url', 'description', 'dateModified', 'publisher', 'isPartOf', 'about'];

function blocks(html) {
  const found = [];
  const re = /<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(re)) {
    try {
      found.push(JSON.parse(match[1]));
    } catch (e) {
      found.push({ __unparseable: e instanceof Error ? e.message : String(e) });
    }
  }
  return found;
}

const problems = [];
let checked = 0;

/**
 * Blog posts are different in kind: Docusaurus emits their BlogPosting, and a
 * wrapper adds a fragment carrying the same identifier so the post names its
 * publisher. Both halves must be there — the fragment alone attributes
 * nothing, and the article alone is unattributed.
 */
function checkBlog(file, parsed) {
  const post = parsed.find((b) => b['@type'] === 'BlogPosting');
  if (!post) {
    problems.push(`blog/${file}: no BlogPosting`);
    return;
  }
  const missing = ['url', 'description', 'datePublished', 'author'].filter((k) => !post[k]);
  if (missing.length) {
    problems.push(`blog/${file}: BlogPosting is missing ${missing.join(', ')}`);
    return;
  }
  const id = post['@id'] ?? post.url;
  const attributed = parsed.some((b) => b['@id'] === id && b.publisher);
  if (!attributed) {
    problems.push(`blog/${file}: nothing attributes the post to a publisher`);
    return;
  }
  checked += 1;
}

const blogDir = join(buildDir, 'blog');
if (existsSync(blogDir)) {
  for (const file of readdirSync(blogDir).filter((f) => f.endsWith('.html'))) {
    if (BLOG_EXEMPT.has(file)) continue;
    const parsed = blocks(readFileSync(join(blogDir, file), 'utf-8'));
    const broken = parsed.find((b) => b.__unparseable);
    if (broken) {
      problems.push(
        `blog/${file}: a structured-data block does not parse — ${broken.__unparseable}`
      );
      continue;
    }
    checkBlog(file, parsed);
  }
}

for (const file of readdirSync(buildDir).filter((f) => f.endsWith('.html'))) {
  if (EXEMPT.has(file)) continue;

  const parsed = blocks(readFileSync(join(buildDir, file), 'utf-8'));

  const broken = parsed.find((b) => b.__unparseable);
  if (broken) {
    problems.push(`${file}: a structured-data block does not parse — ${broken.__unparseable}`);
    continue;
  }

  const page = parsed.find((b) => !b['@graph'] && b['@type'] !== 'BreadcrumbList');
  if (!page) {
    problems.push(`${file}: no page-level structured data (only the site-wide block)`);
    continue;
  }

  const missing = REQUIRED.filter((key) => !page[key]);
  if (missing.length) {
    problems.push(`${file}: ${page['@type']} is missing ${missing.join(', ')}`);
    continue;
  }

  if (page['@type'] === 'HowTo' && !(page.step?.length >= 2)) {
    problems.push(`${file}: HowTo with fewer than two steps`);
    continue;
  }
  if (page['@type'] === 'FAQPage' && !(page.mainEntity?.length >= 3)) {
    problems.push(`${file}: FAQPage with fewer than three question/answer pairs`);
    continue;
  }

  checked += 1;
}

if (problems.length) {
  console.error('✗ structured data is missing or broken:');
  for (const p of problems) console.error(`    ${p}`);
  console.error('\nRebuild and check website/src/page-schemas.json and the DocItem wrapper.');
  process.exit(1);
}

console.log(`✓ ${checked} pages carry their own structured data`);
