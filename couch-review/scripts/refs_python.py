# refs-python.mjs 가 부른다. stdin: {"repo": 경로, "paths": [저장소 기준 .py 경로], "shown": [페이지에 실린 경로]}
# 표준 ast 로 정의·사용을 모아 refs.mjs 와 같은 형식 {paths, symbols: [name, defs, refs], snippets} 를 stdout 에 JSON 으로 낸다.
# 타입 추론은 하지 않는다: 클래스·함수(메서드)·모듈/클래스 변수·속성은 저장소 전체에서 이름으로 묶고,
# 함수 안 지역 변수·파라미터는 그 함수 안에서만 묶는다.
import ast
import json
import os
import sys

req = json.load(sys.stdin)
repo = req["repo"]
shown = set(req["shown"])

symbols = {}


def sym(key, name):
    if key not in symbols:
        symbols[key] = {"name": name, "defs": set(), "refs": set(), "def_at": set()}
    return symbols[key]


paths = []
trees = []
for path in req["paths"]:
    try:
        with open(os.path.join(repo, path), encoding="utf-8") as fh:
            src = fh.read()
        tree = ast.parse(src)
    except (OSError, SyntaxError, ValueError):
        continue
    trees.append((len(paths), tree))
    paths.append(path)


def name_pos(node, name):
    # def/class 이름은 노드 시작이 아니라 키워드 뒤에 있으므로 줄만 쓴다.
    return node.lineno


class Defs(ast.NodeVisitor):
    def __init__(self, p):
        self.p = p
        self.scope = []  # 함수 스코프 키 목록
        self.kinds = []  # 'class' | 'func' — 클래스 본문의 대입은 A: 로만 센다

    def add(self, key, name, node, line=None):
        s = sym(key, name)
        ln = line or node.lineno
        s["defs"].add((self.p, ln))
        s["def_at"].add((self.p, ln, name))

    def visit_ClassDef(self, node):
        self.add("T:" + node.name, node.name, node)
        for stmt in node.body:
            if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                for t in targets:
                    for n in ast.walk(t):
                        if isinstance(n, ast.Name):
                            self.add("A:" + n.id, n.id, n)
        self.kinds.append("class")
        self.generic_visit(node)
        self.kinds.pop()

    def visit_FunctionDef(self, node):
        self.add("M:" + node.name, node.name, node)
        scope = "L:%d:%d:" % (self.p, node.lineno)
        args = node.args
        for a in args.posonlyargs + args.args + args.kwonlyargs + [args.vararg, args.kwarg]:
            if a is not None and a.arg not in ("self", "cls"):
                self.add(scope + a.arg, a.arg, a)
        self.scope.append(scope)
        self.kinds.append("func")
        self.generic_visit(node)
        self.kinds.pop()
        self.scope.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Store):
            if self.kinds and self.kinds[-1] == "class":
                return
            if self.scope:
                self.add(self.scope[-1] + node.id, node.id, node)
            else:
                self.add("V:" + node.id, node.id, node)

    def visit_Attribute(self, node):
        if isinstance(node.ctx, ast.Store) and isinstance(node.value, ast.Name) and node.value.id == "self":
            self.add("A:" + node.attr, node.attr, node, node.end_lineno)
        self.generic_visit(node)


for p, tree in trees:
    Defs(p).visit(tree)


def add_ref(key, p, line, name):
    s = symbols.get(key)
    if s is None or (p, line, name) in s["def_at"]:
        return
    s["refs"].add((p, line))


class Uses(ast.NodeVisitor):
    def __init__(self, p):
        self.p = p
        self.scope = []

    def visit_FunctionDef(self, node):
        for d in node.decorator_list:
            self.visit(d)
        self.scope.append("L:%d:%d:" % (self.p, node.lineno))
        for stmt in node.body:
            self.visit(stmt)
        for d in node.args.defaults + [d for d in node.args.kw_defaults if d is not None]:
            self.visit(d)
        self.scope.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Name(self, node):
        name = node.id
        for scope in reversed(self.scope):
            if scope + name in symbols:
                add_ref(scope + name, self.p, node.lineno, name)
                return
        for prefix in ("T:", "M:", "V:"):
            if prefix + name in symbols:
                add_ref(prefix + name, self.p, node.lineno, name)
                return

    def visit_Attribute(self, node):
        name = node.attr
        line = node.end_lineno
        for prefix in ("M:", "A:", "V:", "T:"):
            if prefix + name in symbols:
                add_ref(prefix + name, self.p, line, name)
                break
        self.visit(node.value)

    def visit_ImportFrom(self, node):
        for alias in node.names:
            for prefix in ("T:", "M:", "V:"):
                if prefix + alias.name in symbols:
                    add_ref(prefix + alias.name, self.p, node.lineno, alias.name)
                    break


for p, tree in trees:
    Uses(p).visit(tree)

shown_p = {p for p, path in enumerate(paths) if path in shown}
out = [s for s in symbols.values() if any(p in shown_p for p, _ in s["defs"] | s["refs"])]

needed = {}
for s in out:
    for p, line in s["defs"] | s["refs"]:
        if paths[p] in shown:
            continue
        needed.setdefault(p, set()).add(line)
snippets = {}
for p, lines in needed.items():
    with open(os.path.join(repo, paths[p]), encoding="utf-8") as fh:
        text = fh.read().split("\n")
    snippets[str(p)] = {str(l): (text[l - 1].strip()[:200] if 0 < l <= len(text) else "") for l in lines}


def pack(locs):
    by_path = {}
    for p, line in locs:
        by_path.setdefault(p, set()).add(line)
    return "|".join("%d:%s" % (p, ",".join(str(l) for l in sorted(ls))) for p, ls in by_path.items())


json.dump({"paths": paths, "symbols": [[s["name"], pack(s["defs"]), pack(s["refs"])] for s in out], "snippets": snippets}, sys.stdout)
