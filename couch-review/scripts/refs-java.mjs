// build.mjs 가 부른다. 먼저 RefsJava.java(javac 실제 분석, Lombok 포함)로 같은 요소를 가리키는 위치만 묶는다.
// 클래스패스는 Gradle init 스크립트(classpath.init.gradle)로 받아 <git-dir>/couch-review/java-classpath.json 에 캐시한다
// (build.gradle·settings.gradle 내용이 바뀌면 다시 받는다). 이 경로가 실패하면 아래 이름 기준 방식으로 돌아간다:
// 저장소의 Java 파일을 토큰으로 훑어, 컴파일러 없이 이름으로 묶으므로 같은 이름의 메서드는 클래스가 달라도 한 묶음이 된다.
// 대상은 저장소에 정의가 있는 이름만: 타입(class·interface·enum·record·@interface), 메서드(record 컴포넌트 접근자 포함),
// 클래스 수준 필드, 상수·enum 상수. 지역 변수·파라미터와 Lombok 이 만드는 메서드는 다루지 않는다.
// 결과 형식은 refs.mjs 와 같다: { paths, symbols: [name, defs, refs], snippets }.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const JAVAC_OPENS = ['code', 'comp', 'file', 'main', 'model', 'parser', 'processing', 'tree', 'util', 'jvm', 'api']
  .flatMap((pkg) => ['--add-opens', `jdk.compiler/com.sun.tools.javac.${pkg}=ALL-UNNAMED`]);

const KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record yield sealed permits non-sealed true false null').split(' '));
const TYPE_DECL = new Set(['class', 'interface', 'enum', 'record']);

// 주석·문자열·문자 리터럴·숫자는 건너뛰고 식별자와 기호만 남긴다.
function tokenize(src) {
  const out = [];
  let line = 1;
  const n = src.length;
  for (let i = 0; i < n;) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (ch === '"' && src.startsWith('"""', i)) {
      i += 3;
      while (i < n && !src.startsWith('"""', i)) { if (src[i] === '\\') i++; else if (src[i] === '\n') line++; i++; }
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < n && src[i] !== ch && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      out.push({ t: 'id', s: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) { let j = i + 1; while (j < n && /[\w.]/.test(src[j])) j++; i = j; continue; }
    if (ch === ':' && src[i + 1] === ':') { out.push({ t: 'sym', s: '::', line }); i += 2; continue; }
    if (ch === '-' && src[i + 1] === '>') { out.push({ t: 'sym', s: '->', line }); i += 2; continue; }
    out.push({ t: 'sym', s: ch, line });
    i++;
  }
  return out;
}

const isName = (tok) => tok?.t === 'id' && !KEYWORDS.has(tok.s);
// 선언의 이름 앞에 올 수 있는 타입의 끝: 이름, 기본형, void, 제네릭 닫기, 배열.
const endsType = (tok) => tok && ((tok.t === 'id' && (!KEYWORDS.has(tok.s) || /^(void|boolean|byte|char|short|int|long|float|double|var)$/.test(tok.s))) || tok.s === '>' || tok.s === ']');

// 파일 하나에서 정의를 찾는다. 반환: [{ kind: 'type'|'method'|'field'|'const', name, line, i }]
function findDefs(toks) {
  const defs = [];
  // 중괄호마다 { kind: 'type'|'enum'|'block', enumHead } 를 쌓는다. 클래스 수준 = 맨 위가 type/enum.
  const stack = [];
  let pendingType = null;
  let paren = 0;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (tok.s === '(') paren++;
    else if (tok.s === ')') paren = Math.max(0, paren - 1);
    else if (tok.s === '{') {
      if (pendingType) { stack.push({ kind: pendingType === 'enum' ? 'enum' : 'type', enumHead: pendingType === 'enum' }); pendingType = null; }
      else if (prev?.s === ')' && isAnonymousClass(toks, i)) stack.push({ kind: 'type' });
      else stack.push({ kind: 'block' });
      paren = 0;
      continue;
    } else if (tok.s === '}') { stack.pop(); continue; }

    const top = stack[stack.length - 1];
    if (tok.s === ';' && top?.kind === 'enum') top.enumHead = false;
    if (tok.t !== 'id') continue;

    if (TYPE_DECL.has(tok.s) && prev?.s !== '.' && isName(next)) {
      if (tok.s === 'record' && toks[i + 2]?.s !== '(' && toks[i + 2]?.s !== '<') continue;
      defs.push({ kind: 'type', name: next.s, line: next.line, i: i + 1 });
      pendingType = tok.s;
      if (tok.s === 'record') collectRecordComponents(toks, i + 2, defs);
      i++;
      continue;
    }
    if (tok.s === 'interface' && prev?.s === '@' && isName(next)) {
      defs.push({ kind: 'type', name: next.s, line: next.line, i: i + 1 });
      pendingType = 'interface';
      i++;
      continue;
    }
    if (!isName(tok) || prev?.s === '@' || prev?.s === '.' || paren > 0) continue;
    if (!top || top.kind === 'block') continue;

    if (top.kind === 'enum' && top.enumHead && (prev?.s === '{' || prev?.s === ',') && [',', ';', '(', '{', '}'].includes(next?.s)) {
      defs.push({ kind: 'const', name: tok.s, line: tok.line, i });
      continue;
    }
    if (next?.s === '(' && endsType(prev) && !pendingType) {
      defs.push({ kind: 'method', name: tok.s, line: tok.line, i });
      continue;
    }
    if ([';', '=', ','].includes(next?.s) && endsType(prev) && !pendingType) {
      defs.push({ kind: /^[A-Z][A-Z0-9_]*$/.test(tok.s) ? 'const' : 'field', name: tok.s, line: tok.line, i });
    }
  }
  return defs;
}

function isAnonymousClass(toks, braceAt) {
  // new X(...) { 형태면 익명 클래스 본문.
  let depth = 0;
  for (let k = braceAt - 1; k >= 0; k--) {
    if (toks[k].s === ')') depth++;
    else if (toks[k].s === '(') { depth--; if (depth === 0) { let m = k - 1; while (m >= 0 && (isName(toks[m]) || toks[m].s === '.' || toks[m].s === '>' || toks[m].s === '<' || toks[m].s === ',')) m--; return toks[m]?.s === 'new' || toks[m + 1]?.s === 'new'; } }
  }
  return false;
}

function collectRecordComponents(toks, from, defs) {
  let k = from;
  if (toks[k]?.s === '<') { let d = 0; for (; k < toks.length; k++) { if (toks[k].s === '<') d++; else if (toks[k].s === '>' && --d === 0) { k++; break; } } }
  if (toks[k]?.s !== '(') return;
  let depth = 0;
  for (; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.s === '(') depth++;
    else if (tok.s === ')') { if (--depth === 0) return; }
    else if (depth === 1 && isName(tok) && toks[k - 1]?.s !== '@' && toks[k - 1]?.s !== '.' && (toks[k + 1]?.s === ',' || toks[k + 1]?.s === ')') && endsType(toks[k - 1])) {
      defs.push({ kind: 'method', name: tok.s, line: tok.line, i: k });
    }
  }
}

export function collectJavaRefs(repo, files) {
  try {
    const refs = collectJavaRefsByJavac(repo, files);
    if (refs) return refs;
  } catch (error) {
    console.log(`java refs: javac 분석 실패, 이름 기준으로 대체 — ${String(error.message).split('\n')[0]}`);
  }
  return collectJavaRefsByName(repo, files);
}

function gradleClasspath(repo, stateDir) {
  const build = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']
    .map((f) => (existsSync(join(repo, f)) ? readFileSync(join(repo, f), 'utf8') : '')).join('\0');
  if (!build.replace(/\0/g, '')) return null;
  const key = createHash('sha1').update(build).digest('hex');
  const cacheFile = join(stateDir, 'java-classpath.json');
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (cached.key === key) return cached;
  }
  const gradlew = join(repo, 'gradlew');
  if (!existsSync(gradlew)) return null;
  const out = execFileSync(gradlew, ['-q', '--offline', '-I', join(here, 'classpath.init.gradle'), 'couchReviewClasspath'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  const cp = out.match(/^COUCH_CP=(.*)$/m)?.[1];
  const ap = out.match(/^COUCH_AP=(.*)$/m)?.[1] ?? '';
  if (cp === undefined) return null;
  const result = { key, cp, ap };
  writeFileSync(cacheFile, JSON.stringify(result));
  return result;
}

function collectJavaRefsByJavac(repoArg, files) {
  const repo = resolve(repoArg);
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  const stateDir = join(gitDir, 'couch-review');
  mkdirSync(stateDir, { recursive: true });
  const classpath = gradleClasspath(repo, stateDir);
  if (!classpath) return null;
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.java'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
  const deleted = new Set(files.filter((f) => f.status === 'D').map((f) => f.path));
  const paths = listed.split('\n').filter((p) => p && !deleted.has(p) && existsSync(join(repo, p)));
  if (!paths.length) return null;
  const listFile = join(stateDir, 'java-sources.txt');
  const shownFile = join(stateDir, 'java-shown.txt');
  const outFile = join(stateDir, 'java-refs.json');
  writeFileSync(listFile, paths.join('\n'));
  writeFileSync(shownFile, files.map((f) => f.path).join('\n'));
  // 저장소 밖에서 만든 소스(jOOQ 등)는 타입 해석에만 쓴다.
  const generated = ['build/generated-sources', 'build/generated/sources'].map((d) => join(repo, d)).filter(existsSync).join(':');
  // 애너테이션 프로세서는 Lombok 만 돌린다(생성 메서드가 있어야 호출이 해석된다). 다른 프로세서는 분석에 필요 없고 실패하기도 한다.
  const processors = classpath.ap.split(':').filter((jar) => /\/lombok[^/]*\.jar$/.test(jar)).join(':');
  const result = execFileSync('java', [...JAVAC_OPENS, join(here, 'RefsJava.java'), repo, listFile, shownFile, classpath.cp, processors, generated, outFile],
    { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'inherit'] });
  void result;
  return JSON.parse(readFileSync(outFile, 'utf8'));
}

function collectJavaRefsByName(repo, files) {
  let listed;
  try { listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.java'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return null; }
  const deleted = new Set(files.filter((f) => f.status === 'D').map((f) => f.path));
  const paths = listed.split('\n').filter((p) => p && !deleted.has(p));
  if (!paths.length) return null;
  const shown = new Set(files.map((f) => f.path));

  const parsed = [];
  for (const path of paths) {
    let src;
    try { src = readFileSync(join(repo, path), 'utf8'); } catch { continue; }
    const toks = tokenize(src);
    parsed.push({ p: parsed.length, path, toks, defs: findDefs(toks) });
  }
  const outPaths = parsed.map((f) => f.path);

  // 키: 타입·메서드·상수는 저장소 전체 이름, 소문자 필드는 그 파일 안.
  const symbols = new Map();
  const symbolFor = (key, name) => {
    if (!symbols.has(key)) symbols.set(key, { name, defs: new Set(), refs: new Set(), defAt: new Set() });
    return symbols.get(key);
  };
  for (const f of parsed) for (const d of f.defs) {
    const key = d.kind === 'field' ? `F:${f.p}:${d.name}` : d.kind === 'method' ? `M:${d.name}` : d.kind === 'type' ? `T:${d.name}` : `C:${d.name}`;
    const s = symbolFor(key, d.name);
    s.defs.add(`${f.p}:${d.line}`);
    s.defAt.add(`${f.p}:${d.i}`);
  }
  const has = (key) => symbols.has(key);
  for (const f of parsed) {
    f.toks.forEach((tok, i) => {
      if (tok.t !== 'id') return;
      const here = `${f.p}:${i}`;
      const prev = f.toks[i - 1];
      const next = f.toks[i + 1];
      const keys = [];
      if (next?.s === '(' || prev?.s === '::') { if (has(`M:${tok.s}`)) keys.push(`M:${tok.s}`); }
      else {
        if (has(`T:${tok.s}`)) keys.push(`T:${tok.s}`);
        if (has(`C:${tok.s}`)) keys.push(`C:${tok.s}`);
        const fieldKey = `F:${f.p}:${tok.s}`;
        if (has(fieldKey) && (prev?.s !== '.' || f.toks[i - 2]?.s === 'this')) keys.push(fieldKey);
      }
      if (next?.s === '(' && has(`T:${tok.s}`) && prev?.s === 'new') keys.push(`T:${tok.s}`);
      for (const key of new Set(keys)) {
        const s = symbols.get(key);
        if (s.defAt.has(here)) continue;
        s.refs.add(`${f.p}:${tok.line}`);
      }
    });
  }

  const shownP = new Set(parsed.filter((f) => shown.has(f.path)).map((f) => f.p));
  const inShown = (loc) => shownP.has(Number(loc.split(':')[0]));
  const out = [...symbols.values()].filter((s) => [...s.defs, ...s.refs].some(inShown));

  const needed = new Map();
  for (const s of out) for (const loc of [...s.defs, ...s.refs]) {
    const [p, line] = loc.split(':').map(Number);
    if (shown.has(outPaths[p])) continue;
    if (!needed.has(p)) needed.set(p, new Set());
    needed.get(p).add(line);
  }
  const snippets = {};
  for (const [p, lines] of needed) {
    const text = readFileSync(join(repo, outPaths[p]), 'utf8').split('\n');
    snippets[p] = Object.fromEntries([...lines].map((l) => [l, text[l - 1]?.trim().slice(0, 200) ?? '']));
  }
  const pack = (set) => {
    const byPath = new Map();
    for (const loc of set) {
      const [p, line] = loc.split(':').map(Number);
      if (!byPath.has(p)) byPath.set(p, new Set());
      byPath.get(p).add(line);
    }
    return [...byPath].map(([p, lines]) => `${p}:${[...lines].sort((a, b) => a - b).join(',')}`).join('|');
  };
  return { paths: outPaths, symbols: out.map((s) => [s.name, pack(s.defs), pack(s.refs)]), snippets };
}
