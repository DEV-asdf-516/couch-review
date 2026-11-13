// 사용: node remap.mjs <repo> <ArtifactData list out_dir 아래 comments 폴더>
// 지난 빌드의 스냅샷(latest-snap.txt)과 지금 작업 트리를 비교해 새 쪽(n) 코멘트의 줄 번호를 옮기고,
// ArtifactData batch 에 넘길 writes 를 <git-dir>/couch-review/updates.json 으로 쓴다.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [repoArg, commentsDir] = process.argv.slice(2);
const repo = resolve(repoArg);
const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repo, encoding: 'utf8' }).trim();
const state = join(resolve(repo, gitDir), 'couch-review');
const snap = readFileSync(join(state, 'latest-snap.txt'), 'utf8').trim();

const hunksCache = new Map();
function hunksOf(path) {
  if (hunksCache.has(path)) return hunksCache.get(path);
  const before = join(snap, path);
  const after = join(repo, path);
  let hunks = null;
  if (existsSync(before) && existsSync(after)) {
    let out = '';
    try {
      out = execFileSync('git', ['diff', '--no-index', '--no-color', '-U0', before, after], { encoding: 'utf8', maxBuffer: 1 << 26 });
    } catch (error) {
      if (error.status !== 1) throw error;
      out = error.stdout;
    }
    hunks = [...out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => {
      const b = m[2] === undefined ? 1 : Number(m[2]);
      const d = m[4] === undefined ? 1 : Number(m[4]);
      // 길이 0 인 쪽은 git 이 "그 앞 줄"을 적으므로 한 줄 뒤로 맞춘다.
      return { a: Number(m[1]) + (b === 0 ? 1 : 0), b, c: Number(m[3]) + (d === 0 ? 1 : 0), d };
    });
  }
  hunksCache.set(path, hunks);
  return hunks;
}

function mapLine(hunks, line) {
  let delta = 0;
  for (const { a, b, c, d } of hunks) {
    if (line < a) break;
    if (line < a + b) return d > 0 ? c + Math.min(line - a, d - 1) : c;
    delta = c + d - (a + b);
  }
  return line + delta;
}

const writes = [];
const log = [];
const commentPaths = new Set();
for (const name of existsSync(commentsDir) ? readdirSync(commentsDir) : []) {
  if (!name.endsWith('.json')) continue;
  const raw = JSON.parse(readFileSync(join(commentsDir, name), 'utf8'));
  const doc = raw.data ?? raw;
  const version = raw.version ?? doc.version;
  const id = raw.id ?? raw.doc_id ?? name.replace(/\.json$/, '');
  if (typeof doc.path === 'string') commentPaths.add(doc.path);
  if (doc.side !== 'n' || typeof doc.line !== 'number') continue;
  const hunks = hunksOf(doc.path);
  if (!hunks) continue;
  const next = mapLine(hunks, doc.line);
  if (next === doc.line) continue;
  writes.push({ op: 'update', collection: 'comments', doc_id: id, data: { line: next }, if_version: version });
  log.push(`${doc.path}:${doc.line} -> ${next}`);
}
writeFileSync(join(state, 'updates.json'), JSON.stringify(writes, null, 2));
// build.mjs 가 변경 목록에서 빠진 파일의 코멘트(해결된 것 포함)도 "변경 없음" 보기로 열 수 있게 싣는다.
writeFileSync(join(state, 'comment-paths.json'), JSON.stringify([...commentPaths].sort(), null, 2));
console.log(`updates: ${join(state, 'updates.json')} (${writes.length})`);
for (const line of log) console.log('  ' + line);
