// refs-java.mjs 가 `java RefsJava.java <args>` 로 부른다. javac 로 소스를 실제로 분석(Lombok 포함)해서
// 같은 요소(클래스·메서드·필드·지역 변수)를 가리키는 위치만 묶는다. 결과는 refs.mjs 와 같은 형식의 JSON 이다.
// args: repo listFile shownFile classpath processorpath extraSourceRoots(경로구분자) outFile
import com.sun.source.tree.*;
import com.sun.source.util.*;

import javax.lang.model.element.*;
import javax.tools.*;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.*;

public class RefsJava {
  static final class Sym {
    final String name;
    final TreeSet<Long> defs = new TreeSet<>();
    final TreeSet<Long> refs = new TreeSet<>();
    Sym(String name) { this.name = name; }
  }

  public static void main(String[] args) throws Exception {
    Path repo = Path.of(args[0]);
    List<String> rel = Files.readAllLines(Path.of(args[1])).stream().filter(s -> !s.isBlank()).toList();
    Set<String> shown = new HashSet<>(Files.readAllLines(Path.of(args[2])));
    String classpath = args[3];
    String processorpath = args[4];
    List<File> extra = new ArrayList<>();
    for (String root : args[5].split(File.pathSeparator)) {
      if (root.isBlank() || !Files.isDirectory(Path.of(root))) continue;
      try (Stream<Path> walk = Files.walk(Path.of(root))) {
        walk.filter(p -> p.toString().endsWith(".java")).forEach(p -> extra.add(p.toFile()));
      }
    }
    Path out = Path.of(args[6]);

    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    StandardJavaFileManager fm = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8);
    Map<String, Integer> indexOf = new HashMap<>();
    List<File> files = new ArrayList<>();
    for (int i = 0; i < rel.size(); i++) {
      File f = repo.resolve(rel.get(i)).toFile();
      files.add(f);
      indexOf.put(f.getCanonicalPath(), i);
    }
    List<File> all = new ArrayList<>(files);
    all.addAll(extra);
    List<String> opts = new ArrayList<>(List.of("-encoding", "UTF-8", "-implicit:none", "-nowarn", "-Xlint:none", "-XDshould-stop.ifError=FLOW", "-XDshould-stop.ifNoError=FLOW"));
    // 프로세서가 파일을 쓰더라도 저장소가 아니라 임시 폴더에 쓰게 한다.
    Path scratch = Files.createTempDirectory("couch-review-javac");
    opts.addAll(List.of("-d", scratch.toString(), "-s", scratch.toString()));
    if (!classpath.isBlank()) { opts.add("-classpath"); opts.add(classpath); }
    if (!processorpath.isBlank()) { opts.add("-processorpath"); opts.add(processorpath); } else opts.add("-proc:none");
    DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
    JavacTask task = (JavacTask) compiler.getTask(null, fm, diags, opts, null, fm.getJavaFileObjectsFromFiles(all));
    Iterable<? extends CompilationUnitTree> units = task.parse();
    task.analyze();
    Trees trees = Trees.instance(task);
    SourcePositions positions = trees.getSourcePositions();

    Map<CompilationUnitTree, Integer> ours = new IdentityHashMap<>();
    for (CompilationUnitTree unit : units) {
      Integer p = indexOf.get(new File(unit.getSourceFile().toUri()).getCanonicalPath());
      if (p != null) ours.put(unit, p);
    }
    Map<Element, Boolean> own = new IdentityHashMap<>();
    Map<Element, Sym> symbols = new IdentityHashMap<>();

    for (Map.Entry<CompilationUnitTree, Integer> entry : ours.entrySet()) {
      CompilationUnitTree unit = entry.getKey();
      int p = entry.getValue();
      String src = unit.getSourceFile().getCharContent(true).toString();
      LineMap lines = unit.getLineMap();
      new TreePathScanner<Void, Void>() {
        void record(Element e, long pos, boolean def) {
          if (e == null || pos < 0) return;
          if (e.getKind() == ElementKind.CONSTRUCTOR) e = e.getEnclosingElement();
          if (e.getKind() == ElementKind.PACKAGE) return;
          String name = e.getSimpleName().toString();
          if (name.isEmpty() || pos + name.length() > src.length() || !src.startsWith(name, (int) pos)) return;
          if (!own.computeIfAbsent(e, x -> { TreePath tp = trees.getPath(x); return tp != null && ours.containsKey(tp.getCompilationUnit()); })) return;
          Sym s = symbols.computeIfAbsent(e, x -> new Sym(name));
          long loc = ((long) p << 32) | lines.getLineNumber(pos);
          (def ? s.defs : s.refs).add(loc);
        }
        long find(String name, long from, Tree tree) {
          if (from < 0) return -1;
          long end = positions.getEndPosition(unit, tree);
          for (int at = src.indexOf(name, (int) from); at >= 0 && (end < 0 || at < end); at = src.indexOf(name, at + 1)) {
            boolean left = at == 0 || !Character.isJavaIdentifierPart(src.charAt(at - 1));
            boolean right = at + name.length() >= src.length() || !Character.isJavaIdentifierPart(src.charAt(at + name.length()));
            if (left && right) return at;
          }
          return -1;
        }
        @Override public Void visitClass(ClassTree t, Void v) {
          long from = Math.max(positions.getStartPosition(unit, t), positions.getEndPosition(unit, t.getModifiers()));
          record(trees.getElement(getCurrentPath()), find(t.getSimpleName().toString(), from, t), true);
          return super.visitClass(t, v);
        }
        @Override public Void visitMethod(MethodTree t, Void v) {
          Element e = trees.getElement(getCurrentPath());
          String name = e != null && e.getKind() == ElementKind.CONSTRUCTOR ? e.getEnclosingElement().getSimpleName().toString() : t.getName().toString();
          long from = t.getReturnType() != null ? positions.getEndPosition(unit, t.getReturnType()) : Math.max(positions.getStartPosition(unit, t), positions.getEndPosition(unit, t.getModifiers()));
          record(e, find(name, from, t), true);
          return super.visitMethod(t, v);
        }
        @Override public Void visitVariable(VariableTree t, Void v) {
          long from = t.getType() != null ? positions.getEndPosition(unit, t.getType()) : positions.getStartPosition(unit, t);
          if (from < 0) from = positions.getStartPosition(unit, t);
          record(trees.getElement(getCurrentPath()), find(t.getName().toString(), from, t), true);
          return super.visitVariable(t, v);
        }
        @Override public Void visitIdentifier(IdentifierTree t, Void v) {
          record(trees.getElement(getCurrentPath()), positions.getStartPosition(unit, t), false);
          return super.visitIdentifier(t, v);
        }
        @Override public Void visitMemberSelect(MemberSelectTree t, Void v) {
          long end = positions.getEndPosition(unit, t);
          if (end >= 0) record(trees.getElement(getCurrentPath()), end - t.getIdentifier().length(), false);
          return super.visitMemberSelect(t, v);
        }
        @Override public Void visitMemberReference(MemberReferenceTree t, Void v) {
          long end = positions.getEndPosition(unit, t);
          if (end >= 0) record(trees.getElement(getCurrentPath()), end - t.getName().length(), false);
          return super.visitMemberReference(t, v);
        }
      }.scan(unit, null);
    }

    Set<Integer> shownIdx = new HashSet<>();
    for (int i = 0; i < rel.size(); i++) if (shown.contains(rel.get(i))) shownIdx.add(i);
    List<Sym> outSyms = new ArrayList<>();
    for (Sym s : symbols.values()) {
      s.refs.removeAll(s.defs);
      boolean visible = Stream.concat(s.defs.stream(), s.refs.stream()).anyMatch(loc -> shownIdx.contains((int) (loc >>> 32)));
      if (visible) outSyms.add(s);
    }
    Map<Integer, TreeSet<Integer>> needed = new TreeMap<>();
    for (Sym s : outSyms) for (long loc : concat(s)) {
      int p = (int) (loc >>> 32);
      if (!shownIdx.contains(p)) needed.computeIfAbsent(p, x -> new TreeSet<>()).add((int) loc);
    }

    StringBuilder json = new StringBuilder("{\"paths\":[");
    for (int i = 0; i < rel.size(); i++) { if (i > 0) json.append(','); str(json, rel.get(i)); }
    json.append("],\"symbols\":[");
    boolean first = true;
    for (Sym s : outSyms) {
      if (!first) json.append(',');
      first = false;
      json.append('[');
      str(json, s.name);
      json.append(',');
      str(json, pack(s.defs));
      json.append(',');
      str(json, pack(s.refs));
      json.append(']');
    }
    json.append("],\"snippets\":{");
    first = true;
    for (Map.Entry<Integer, TreeSet<Integer>> e : needed.entrySet()) {
      List<String> text = Files.readAllLines(repo.resolve(rel.get(e.getKey())), StandardCharsets.UTF_8);
      if (!first) json.append(',');
      first = false;
      json.append('"').append(e.getKey()).append("\":{");
      boolean f2 = true;
      for (int line : e.getValue()) {
        if (!f2) json.append(',');
        f2 = false;
        String s = line >= 1 && line <= text.size() ? text.get(line - 1).strip() : "";
        json.append('"').append(line).append("\":");
        str(json, s.length() > 200 ? s.substring(0, 200) : s);
      }
      json.append('}');
    }
    json.append("}}");
    Files.writeString(out, json.toString(), StandardCharsets.UTF_8);
    long errors = diags.getDiagnostics().stream().filter(d -> d.getKind() == Diagnostic.Kind.ERROR).count();
    System.err.println("javac symbols=" + outSyms.size() + " errors=" + errors);
  }

  static List<Long> concat(Sym s) { List<Long> l = new ArrayList<>(s.defs); l.addAll(s.refs); return l; }

  static String pack(TreeSet<Long> locs) {
    Map<Integer, List<Integer>> byPath = new LinkedHashMap<>();
    for (long loc : locs) byPath.computeIfAbsent((int) (loc >>> 32), x -> new ArrayList<>()).add((int) loc);
    return byPath.entrySet().stream().map(e -> e.getKey() + ":" + e.getValue().stream().map(String::valueOf).collect(Collectors.joining(","))).collect(Collectors.joining("|"));
  }

  static void str(StringBuilder b, String s) {
    b.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> b.append("\\\"");
        case '\\' -> b.append("\\\\");
        case '\n' -> b.append("\\n");
        case '\r' -> b.append("\\r");
        case '\t' -> b.append("\\t");
        case '<' -> b.append("\\u003c");
        default -> { if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c); }
      }
    }
    b.append('"');
  }
}
