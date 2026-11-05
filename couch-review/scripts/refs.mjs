// build.mjs 가 부른다. 페이지에 보이는 TS 파일의 이름마다 같은 대상을 가리키는 정의·사용 위치를 저장소 전체에서 모은다.
// findReferences 를 이름마다 부르면 1분 가까이 걸려서, 모든 파일을 한 번 돌며 checker 의 심볼로 묶는다.
// 라이브러리(node_modules, lib.d.ts)에만 정의된 이름은 뺀다. 저장소에 typescript·tsconfig 가 없으면 null.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

export function collectRefs(repo, files) {
  const config = join(repo, 'tsconfig.json');
  if (!existsSync(config)) return null;
  let ts;
  try { ts = createRequire(join(repo, 'package.json'))('typescript'); } catch { return null; }
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) return null;
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const own = (sf) => !sf.fileName.includes('/node_modules/') && !program.isSourceFileDefaultLibrary(sf);

  const symbolOf = (node) => {
    const parent = node.parent;
    // 객체 리터럴의 키는 그 리터럴이 맞춰야 하는 타입의 속성으로 본다.
    if ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) && parent.name === node && ts.isObjectLiteralExpression(parent.parent)) {
      const prop = checker.getContextualType(parent.parent)?.getProperty(node.text);
      if (prop?.declarations?.some((d) => own(d.getSourceFile()))) return prop;
    }
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol) ?? symbol;
    return symbol;
  };

  const shownIds = new Map(files.map((f) => [join(repo, f.path), f.id]));
  const paths = [];
  const symbols = [];
  const symbolIdx = new Map();
  const shownPaths = new Set();
  const usedLines = new Map();

  for (const sf of program.getSourceFiles()) {
    if (!own(sf)) continue;
    const p = paths.push(relative(repo, sf.fileName)) - 1;
    const fid = shownIds.get(sf.fileName);
    if (fid) shownPaths.add(p);
    const visit = (node) => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        const symbol = symbolOf(node);
        const decls = symbol?.declarations ?? [];
        if (decls.length && decls.some((d) => own(d.getSourceFile()))) {
          if (!symbolIdx.has(symbol)) symbolIdx.set(symbol, symbols.push({ name: node.text, defs: [], refs: [] }) - 1);
          const i = symbolIdx.get(symbol);
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const isDef = decls.some((d) => d.name === node);
          symbols[i][isDef ? 'defs' : 'refs'].push([p, line]);
          if (!usedLines.has(p)) usedLines.set(p, new Set());
          usedLines.get(p).add(line);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // 보이는 파일에 나오는 이름만 남긴다. 페이지는 (파일, 줄, 이름)으로 심볼을 찾는다.
  const out = symbols.filter((s) => [...s.defs, ...s.refs].some(([p]) => shownPaths.has(p)));

  // 페이지에 실리지 않는 파일의 줄은 내용을 따로 싣는다.
  const shown = new Set(files.map((f) => f.path));
  const needed = new Map();
  for (const s of out) for (const [p, line] of [...s.defs, ...s.refs]) {
    if (shown.has(paths[p])) continue;
    if (!needed.has(p)) needed.set(p, new Set());
    needed.get(p).add(line);
  }
  const snippets = {};
  for (const [p, lines] of needed) {
    const text = readFileSync(join(repo, paths[p]), 'utf8').split('\n');
    snippets[p] = Object.fromEntries([...lines].map((l) => [l, text[l - 1]?.trim().slice(0, 200) ?? '']));
  }
  // 위치 목록은 "파일번호:줄,줄|파일번호:줄" 문자열로 줄인다.
  const pack = (list) => {
    const byPath = new Map();
    for (const [p, line] of list) {
      if (!byPath.has(p)) byPath.set(p, new Set());
      byPath.get(p).add(line);
    }
    return [...byPath].map(([p, lines]) => `${p}:${[...lines].join(',')}`).join('|');
  };
  return { paths, symbols: out.map((s) => [s.name, pack(s.defs), pack(s.refs)]), snippets };
}
