// build.mjs 가 부른다. 저장소의 Python 파일을 refs_python.py(표준 ast)로 읽어 refs.mjs 와 같은 형식으로 돌려준다.
// python3 이 없거나 .py 가 없으면 null.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function collectPythonRefs(repo, files) {
  let listed;
  try { listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.py'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return null; }
  const deleted = new Set(files.filter((f) => f.status === 'D').map((f) => f.path));
  const paths = listed.split('\n').filter((p) => p && !deleted.has(p));
  if (!paths.length) return null;
  const input = JSON.stringify({ repo, paths, shown: files.map((f) => f.path) });
  let out;
  try { out = execFileSync('python3', ['-I', join(here, 'refs_python.py')], { input, encoding: 'utf8', maxBuffer: 256 << 20 }); } catch { return null; }
  return JSON.parse(out);
}
