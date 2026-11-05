// 사용: node build.mjs <repo>
// 커밋 전 변경(추적 파일 diff + 추적 안 하는 새 파일)을 리뷰 페이지로 만든다.
// 결과와 상태는 <git-dir>/couch-review/ 에 둔다: review.html, snaps/<시각>/, latest-snap.txt, files.json.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRefs } from './refs.mjs';

const repo = resolve(process.argv[2] ?? '.');
const here = dirname(fileURLToPath(import.meta.url));
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (error) {
    if (error.status === 1 && typeof error.stdout === 'string') return error.stdout;
    throw error;
  }
};
const state = join(resolve(repo, git(['rev-parse', '--git-dir']).trim()), 'couch-review');
mkdirSync(state, { recursive: true });

// 파일 전체를 싣는다. 변경만 보기의 접기는 페이지가 한다.
const CONTEXT = '--unified=1000000';
const chunks = [git(['diff', '--no-color', '--no-ext-diff', CONTEXT])];
const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
for (const path of untracked) {
  chunks.push(git(['diff', '--no-color', '--no-ext-diff', '--no-index', CONTEXT, '/dev/null', path]));
}

const files = [];
for (const block of chunks.join('\n').split(/^(?=diff --git )/m)) {
  if (!block.startsWith('diff --git ')) continue;
  const rows = block.split('\n');
  const plus = rows.find((r) => r.startsWith('+++ '));
  const minus = rows.find((r) => r.startsWith('--- '));
  const header = rows[0].match(/^diff --git a\/(.+) b\/(.+)$/);
  let path = header ? header[2] : rows[0];
  let status = 'M';
  if (plus && plus !== '+++ /dev/null') path = plus.slice(6);
  else if (minus) path = minus.slice(6);
  if (minus === '--- /dev/null') status = 'A';
  if (plus === '+++ /dev/null') status = 'D';
  const file = {
    id: 'f' + createHash('sha1').update(path).digest('hex').slice(0, 8),
    path,
    status,
    add: 0,
    del: 0,
    binary: rows.some((r) => r.startsWith('Binary files ')),
    hunks: [],
  };
  let hunk = null;
  let o = 0;
  let n = 0;
  for (const row of rows) {
    const at = row.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
    if (at) {
      o = Number(at[1]);
      n = Number(at[2]);
      hunk = { h: row.replace(/^(@@[^@]*@@).*$/, '$1'), ctx: at[3], lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const t = row[0];
    const s = row.slice(1);
    if (t === ' ') hunk.lines.push([' ', o++, n++, s]);
    else if (t === '-') { hunk.lines.push(['-', o++, 0, s]); file.del++; }
    else if (t === '+') { hunk.lines.push(['+', 0, n++, s]); file.add++; }
  }
  // 확인 표시는 이 값이 같을 때만 유지된다. 확인 뒤 파일이 바뀌면 페이지가 확인을 푼다.
  file.hash = createHash('sha1').update(JSON.stringify(file.hunks)).digest('hex').slice(0, 12);
  files.push(file);
}
files.sort((a, b) => a.path.localeCompare(b.path));

const repoName = basename(git(['rev-parse', '--show-toplevel']).trim());
const data = {
  generatedAt: new Date().toISOString(),
  repo: repoName,
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
  head: git(['rev-parse', '--short', 'HEAD']).trim(),
  files,
  refs: null,
};
const refsStarted = Date.now();
try {
  data.refs = collectRefs(repo, files.filter((f) => f.status !== 'D'));
} catch (error) {
  console.log(`refs skipped: ${error.message}`);
}
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const html = readFileSync(join(here, 'template.html'), 'utf8')
  .replace('__REPO__', () => repoName.replace(/[&<>]/g, ''))
  .replace('/*__DATA__*/', () => json);
writeFileSync(join(state, 'review.html'), html);
writeFileSync(join(state, 'files.json'), JSON.stringify(Object.fromEntries(files.map((f) => [f.path, f.id])), null, 2));

// remap.mjs 가 다음 빌드 전에 코멘트 줄 번호를 옮길 기준: 이번에 올린 diff 의 새 쪽 파일 내용.
const snap = join(state, 'snaps', String(Date.now()));
writeFileSync(join(state, 'latest-snap.txt'), snap);
for (const f of files) {
  const source = join(repo, f.path);
  if (f.status === 'D' || !existsSync(source)) continue;
  mkdirSync(dirname(join(snap, f.path)), { recursive: true });
  copyFileSync(source, join(snap, f.path));
}

// 올리기 전에 눈으로 확인할 비밀값 후보: 추가된 줄만 본다.
const SECRET = new RegExp([
  /(?:api[_-]?key|secret|passw(?:or)?d|token|private[_-]?key)\w*["']?\s*[:=]\s*["'`][^"'`\s]{8,}/.source,
  /^\s*[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*\S{8,}/.source,
  /BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.source,
].join('|'), 'i');
const hits = [];
for (const f of files) for (const h of f.hunks) for (const [t, , n, s] of h.lines) {
  if (t === '+' && SECRET.test(s)) hits.push(`${f.path}:${n}: ${s.trim().slice(0, 160)}`);
}
// 참조 목록에 실리는, 변경 없는 파일의 줄도 본다.
for (const [p, lines] of Object.entries(data.refs?.snippets ?? {})) for (const [n, s] of Object.entries(lines)) {
  if (SECRET.test(s)) hits.push(`${data.refs.paths[p]}:${n} (참조): ${s.slice(0, 160)}`);
}

console.log(`state: ${state}`);
console.log(`page: ${join(state, 'review.html')}`);
console.log(`${files.length} files, ${files.reduce((s, f) => s + f.add, 0)}+ ${files.reduce((s, f) => s + f.del, 0)}-, ${(html.length / 1024).toFixed(0)} KB`);
console.log(`refs: ${data.refs ? `${data.refs.symbols.length} symbols, ${((Date.now() - refsStarted) / 1000).toFixed(1)}s` : 'none'}`);
console.log(`secret candidates: ${hits.length}`);
for (const line of hits.slice(0, 80)) console.log('  ' + line);
if (hits.length > 80) console.log(`  ... ${hits.length - 80} more`);
