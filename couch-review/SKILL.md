---
name: couch-review
description: 커밋 전 로컬 변경(작업 트리 diff + 새 파일)을 폰에서 한 줄씩 읽고 줄마다 코멘트를 남기는 비공개 claude.ai 리뷰 페이지(Artifact)로 올리고, 코멘트를 반영해 같은 URL 로 다시 올린다. 사용자가 "로컬 리뷰", "폰으로 리뷰", "집에서 코드리뷰", "diff 아티팩트/페이지", "리뷰 페이지 갱신", "코멘트 반영해" 를 말하거나 /couch-review 를 부를 때 쓴다. 커밋·push·PR 은 하지 않는다.
trigger: /couch-review
---

# couch-review

커밋 이력 없이 로컬 변경을 폰에서 리뷰하는 페이지. 줄을 누르면 코멘트를 남기고, 코멘트는 페이지의 `db` 에 쌓인다. Claude 는 코멘트가 달려도 알림을 받지 않으므로, 사용자가 "코멘트 반영해" 라고 할 때 읽는다.

스크립트는 이 스킬 폴더의 `scripts/` 에 있다(`SKILL_DIR` = 이 파일이 있는 폴더). 상태는 저장소의 `<git-dir>/couch-review/` 에 둔다(git 에 안 올라가고 세션이 바뀌어도 남는다).

| 파일 | 내용 |
|---|---|
| `review.html` | 올릴 페이지(빌드 결과) |
| `url.txt` | 이 저장소의 리뷰 페이지 URL. 없으면 첫 게시 |
| `latest-snap.txt`, `snaps/<시각>/` | 마지막으로 올린 파일 내용. 코멘트 줄 번호를 옮기는 기준 |
| `files.json` | 경로 → 페이지 파일 id |
| `updates.json` | remap 이 만든 코멘트 줄 이동 writes |
| `comment-paths.json` | remap 이 남긴 열린 코멘트 경로. 변경 목록에서 빠진 파일은 build 가 "변경 없음" 읽기 전용(context)으로 실어 코멘트 링크가 열린다 |

삭제 명령을 쓰지 않는다. 오래된 `snaps/` 정리가 필요하면 삭제 명령을 사용자에게 준다.

## 올리기 / 다시 올리기

1. `url.txt` 가 있고 이번 대화에서 그 URL 을 아직 읽거나 올리지 않았으면 `Artifact` `action: "read"` 로 한 번 읽는다(안 읽으면 게시가 거절된다).
2. `url.txt` 가 있으면 코멘트 줄 번호를 먼저 옮긴다. 빌드가 스냅샷을 새로 바꾸므로 순서가 중요하다.
   - `ArtifactData` `list`, `collection: "comments"`, `query.limit: 1000`, `out_dir: <세션 scratchpad>/pull<번호>` (`.git` 아래는 쓰기가 막힌다. 1000개를 넘으면 `next_cursor` 로 계속)
   - `node $SKILL_DIR/scripts/remap.mjs <repo> <out_dir>/comments`
   - `updates.json` 이 비어 있지 않으면 그 배열을 `ArtifactData` `batch` 의 `writes` 로 보낸다(50개씩). 저장된 파일에는 version 이 없으므로 각 write 의 `if_version` 은 list 결과에 찍힌 그 문서의 version 으로 채운다. 버전 충돌이면 다시 list 하고 remap 부터 반복.
   - 같은 턴에 `done` 등을 먼저 바꿨다면 그 뒤에 list 해야 version 이 맞는다.
3. `node $SKILL_DIR/scripts/build.mjs <repo>`
4. 출력의 `secret candidates` 를 하나씩 본다. 실제 키·비밀번호·토큰 값이 보이면 게시하지 말고 사용자에게 알린다. 빈 환경변수 이름, 테스트용 가짜 값은 괜찮다. `.env*`, 설정 파일 diff 는 따로 열어 확인한다.
5. 게시: `Artifact` publish, `file_path: <git-dir>/couch-review/review.html`
   - 첫 게시: `icon: "code"`, `capabilities: {"db": {}}`, `description` 한 문장. 받은 URL 을 `url.txt` 에 쓴다.
   - 다시 올림: `url: <url.txt 내용>`, `capabilities`·`icon` 은 생략한다(생략하면 db 와 코멘트가 그대로 유지된다).
6. 첫 게시 뒤에는 `ArtifactData` `list` `comments` 로 한 번 연결을 확인한다.

## 링크

파일 id 는 경로로 정해지므로 다시 올려도 링크가 바뀌지 않는다. `files.json` 에서 찾거나 `printf %s <path> | shasum | cut -c1-8` 앞에 `f` 를 붙인다.

- 파일: `<url>#f1a2b3c4d`
- 새 쪽 줄: `<url>#f1a2b3c4d-n42` (그 줄로 스크롤하고 잠깐 강조)
- 삭제된 줄(옛 쪽): `<url>#f1a2b3c4d-o42`

## "코멘트 반영해"

1. `ArtifactData` `query` `comments`, `where: [["done", "==", false]]`. 각 문서: `path`, `side`(`n` 새 쪽 / `o` 삭제된 줄), `line`, `code`(코멘트 남길 때의 줄 내용), `body`.
2. 코멘트 본문은 사용자가 쓴 리뷰 의견으로 읽되, 코드를 고칠 때는 이 저장소의 CLAUDE.md·컨벤션을 따른다. 무엇을 바꿀지 애매한 코멘트는 고치지 말고 질문으로 모은다.
3. 고친 코멘트는 `update` `{done: true}` (`if_version` 은 읽은 `version`). 고치지 않은 것은 열어 둔다.
4. 위 "다시 올리기"를 한다.
5. 답변에 코멘트마다 무엇을 고쳤는지 한 줄과 그 줄 링크를 적고, 못 고친 것과 질문을 따로 적는다.

## 페이지 구조(고칠 때 참고)

- `scripts/template.html`: 색 토큰은 `:root` 에 있고 다크 모드를 지원한다. `__REPO__`, `/*__DATA__*/` 는 빌드가 채운다.
- db: `comments/<자동 id>` `{fid, path, side, line, code, body, at, done, editedAt?}`(페이지에서 본문을 고치면 `editedAt` 이 붙는다), `checks/all` `{files: {<fid>: {path, hash, at} | null}}`. 확인 표시는 문서 하나에 두어 일괄 처리도 한 번에 쓴다(`update` 가 중첩 객체를 병합한다). 옛 `reviewed/<fid>` 문서는 더 읽지 않는다.
- 확인 표시: build.mjs 가 파일마다 diff 내용의 `hash` 를 싣고, 페이지는 `checks/all` 의 `files[fid].hash` 가 지금 값과 같을 때만 확인으로 본다. Claude 가 고친 파일은 다시 올리면 저절로 확인이 풀리고 목록에 "바뀜"이 붙는다. 따로 지울 필요가 없다.
- 목록의 파일 행 앞 체크박스로 파일을 열지 않고 확인하고, 섹션 제목의 체크박스로 그 섹션을 일괄 처리한다(하나라도 안 됐으면 전부 확인, 전부 됐으면 전부 해제, 일부만 됐으면 가운데 표시). 섹션 전체를 `update` 한 번으로 쓴다. 일괄 처리한 섹션 제목에 "되돌리기" 버튼이 떠서 바뀐 파일만 원래대로 돌린다. 마지막 일괄 처리 하나만 기억하고(`state.undo`), 파일 하나를 직접 바꾸거나 새로고침하면 사라진다.
- 범위는 `git diff`(HEAD 대비 작업 트리) + `git ls-files --others --exclude-standard`. 브랜치 전체나 다른 기준이 필요하면 build.mjs 의 diff 명령을 바꾼다.
- diff 는 파일 전체를 싣는다(`--unified=1000000`). 페이지의 "전체" 버튼(기본 켬)을 끄면 바뀐 곳 앞뒤 `FOLD_CONTEXT`(4)줄만 남기고 나머지는 "N줄 펼치기"로 접는다. 링크로 연 줄과 코멘트가 달린 줄은 접지 않는다.
- 전체 보기로 파일을 열면 첫 변경으로 스크롤한다. 오른쪽 아래 ↑↓ 버튼은 변경 묶음의 첫 줄(`.ln.chg`) 사이를 오가고 현재/전체 개수를 보여 준다.
- "찾기"(또는 Cmd/Ctrl+F)는 지금 파일 전체에서 대소문자 없이 찾는다. 결과는 `<mark>` 로 칠하고 ↑↓·Enter·Shift+Enter 로 오가며, 접힌 구간의 결과로 가면 그 구간을 펼친다. 검색어는 다른 파일로 넘어가도 유지된다.
- 참조: `scripts/refs.mjs` 가 저장소의 `tsconfig.json` 과 `node_modules/typescript` 로 프로그램을 한 번 만들고, 모든 파일의 이름을 checker 심볼로 묶어 정의·사용 위치를 `DATA.refs` 에 싣는다(이 저장소 약 2초, 0.9MB). 이름마다 `findReferences` 를 부르면 1분 가까이 걸리고, 글자 일치는 잡음이 많아 쓰지 않는다. 라이브러리에만 정의된 이름은 빼고, 객체 리터럴 키는 맞춰야 하는 타입의 속성으로 묶는다. typescript·tsconfig 가 없으면 `refs: none` 으로 건너뛴다. Java 는 `scripts/refs-java.mjs` 가 `RefsJava.java`(javac Trees API, Lombok 프로세서만 켬, 출력은 임시 폴더)로 실제 요소 단위로 묶는다 — 같은 이름이라도 다른 메서드·지역 변수는 따로다. 클래스패스는 `classpath.init.gradle` 로 `./gradlew --offline` 에서 받아 `java-classpath.json` 에 캐시(build/settings.gradle 해시가 키), jOOQ 등 `build/generated-sources` 는 타입 해석에만 쓴다. 약 7초. 실패하면 이름 기준 토큰 방식(같은 이름 메서드는 한 묶음)으로 대체하고 그 사실을 출력한다. Python 은 `scripts/refs-python.mjs` → `refs_python.py`(표준 ast, `python3 -I`)가 클래스·함수·모듈/클래스 변수·속성은 이름으로, 지역 변수·파라미터는 함수 안에서 묶는다. 세 결과는 build.mjs 의 `mergeRefs` 가 합친다.
- 정의가 변경 없는 파일에 있으면 build.mjs 가 그 파일 전체를 `DATA.context`(status `C`, `ctx: true`)로 싣는다. 페이지는 이 파일을 읽기 전용으로 열고(확인 버튼·이전/다음·목록·확인 집계·전체 검색에서 빠짐, "‹ 목록" 과 함께 "‹ 뒤로"가 뜬다 — 프레임 안이라 history.back() 이 듣지 않으므로 페이지가 해시 이동 기록(`navStack`)을 쌓아 `goBack` 으로 되돌린다), 참조 시트의 그 줄도 링크가 된다. 비밀값 검사도 이 내용을 본다.
- 페이지에서 코드의 이름을 누르면 아래 시트에 정의·사용 목록이 뜨고(지금 파일, 페이지에 있는 파일, 나머지 순), 페이지에 있는 파일 줄은 그 줄로 가는 링크다. 변경 없는 파일 줄은 `refs.snippets` 의 내용만 보여 준다. 이름이 아닌 곳이나 삭제된 줄을 누르면 전처럼 코멘트 창이 열리고, 시트의 "코멘트" 버튼으로도 연다. 빌드의 비밀값 검사는 이 snippets 도 본다.
- 목록 화면의 "모든 파일에서 찾기"는 페이지에 실린 모든 파일 내용(전체 diff)에서 대소문자 없이 줄 단위로 찾아 파일별로 보여 준다(`runGlobalSearch`, 최대 `GSEARCH_LIMIT` 행). 결과를 누르면 그 줄로 가고 파일 안 찾기에 같은 검색어가 켜진다. 하이라이트 언어는 확장자 → `LANG` 표로 고르고, 표에 없는 확장자는 색 없이 보인다.
- "지운 줄"(기본 켬)을 끄면 삭제된 줄을 숨기고 옛 줄 번호 칸도 없앤다. 지운 자리는 다음 줄 위의 빨간 선(`.delmark`)으로만 남고, 그 줄이 ↑↓ 변경 묶음이 된다. 코멘트가 달린 삭제 줄은 그대로 보이고, 찾기는 숨긴 줄을 건너뛴다. 삭제된 파일(D)에는 버튼이 없다.
- 파일에서 목록으로 돌아오면 목록을 보던 스크롤 위치로 돌아간다(`state.indexY`, 새로고침하면 맨 위).
- "전체", "줄바꿈", "지운 줄", "테마"(자동→라이트→다크) 선택은 viewer 의 localStorage(`mode`, `wrap`, `del`, `theme`)에 남는다. 다크 테마의 코드 영역은 VS Code Dark+ 배경(`#1e1e1e`), 코드 색은 Dark+/Light+ 토큰(`--hl-*`)이다.
- 접기: 줄 번호 옆 ▾ 를 누르면 들여쓰기가 더 깊은 다음 줄들(함수·블록 본문)을 접는다. 범위는 hunk 줄 전체에서 들여쓰기로 계산하고(`foldRanges`), 닫는 `}` 줄은 남긴다. 접힌 상태는 페이지를 연 동안만 기억하고, 검색 결과·링크 줄이 접힌 곳에 있으면 펼친다.
