// Unit-тесты блока CORE из attache.html. Запуск: node tests/core.test.mjs
import { test, run, eq, deepEq, truthy, falsy } from './lib/tap.mjs';
import { loadCore } from './lib/core-loader.mjs';

const C = loadCore();

const strip = (lang, text, opts = {}) => C.transformText(text, lang, { stripComments: true, keepDocComments: !!opts.keepDoc, lineNumbers: !!opts.numbered });
const file = (path, text, extra = {}) => ({ path, name: path.split('/').pop(), text, size: text.length, lang: C.detectLang(path.split('/').pop()), tokens: C.estimateTokens(text, C.detectLang(path.split('/').pop())), outTokens: 10, ...extra });
const ignored = (gitignoreText, path) => { const m = C.createGitignoreMatcher(); m.add('', gitignoreText); return m.isFileIgnored(path); };

/* ---------------- Строки, числа, сравнение ---------------- */
test('formatSize: человекочитаемые размеры', () => {
    eq(C.formatSize(0), '0 B');
    eq(C.formatSize(1023), '1023 B');
    eq(C.formatSize(1024), '1 KB');
    eq(C.formatSize(1536), '1.5 KB');
    eq(C.formatSize(1048576), '1 MB');
    eq(C.formatSize(3 * 1048576), '3 MB');
    eq(C.formatSize(1.5 * 1073741824), '1.5 GB');
});

test('formatInt / formatCompact: разделители групп', () => {
    eq(C.formatInt(999), '999');
    eq(C.formatInt(1234567), `1${'\u00a0'}234${'\u00a0'}567`);
    eq(C.formatCompact(999), '999');
    eq(C.formatCompact(45000), '45K');
    eq(C.formatCompact(1200000), '1.2M');
});

test('compareNatural: цифры сравниваются как числа', () => {
    truthy(C.compareNatural('file2.kt', 'file10.kt') < 0);
    truthy(C.compareNatural('file10.kt', 'file2.kt') > 0);
    eq(C.compareNatural('File.kt', 'file.kt'.toUpperCase().toLowerCase()) , 0);
    truthy(C.compareNatural('v1.9.0', 'v1.10.0') < 0);
    truthy(C.compareNatural('a', 'ab') < 0);
});

test('escapeXmlAttr / escapeHtml: спецсимволы', () => {
    eq(C.escapeXmlAttr('a"b<c>&d'), 'a&quot;b&lt;c&gt;&amp;d');
    eq(C.escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

/* ---------------- Языки ---------------- */
test('detectLang: расширение задаёт язык', () => {
    eq(C.detectLang('Main.kt'), 'kotlin');
    eq(C.detectLang('build.gradle.kts'), 'kotlin');
    eq(C.detectLang('build.gradle'), 'groovy');
    eq(C.detectLang('Dockerfile'), 'docker');
    eq(C.detectLang('Dockerfile.prod'), 'docker');
    eq(C.detectLang('.env'), 'properties');
    eq(C.detectLang('.env.production'), 'plain');
    eq(C.detectLang('Makefile'), 'make');
    eq(C.detectLang('index.html'), 'xml');
    eq(C.detectLang('README.MD'), 'markdown');
    eq(C.detectLang('x.unknownext'), 'plain');
    eq(C.detectLang('README'), 'plain');
    eq(C.detectLang('.gitignore'), 'plain');
});

test('getExt: расширение в нижнем регистре с точкой', () => {
    eq(C.getExt('Main.KT'), '.kt');
    eq(C.getExt('.env'), '.env');
    eq(C.getExt('Makefile'), '');
    eq(C.getExt('archive.tar.gz'), '.gz');
});

/* ---------------- Оценка токенов ---------------- */
test('estimateTokens: пустой файл — 0 токенов', () => {
    eq(C.estimateTokens('', 'kotlin'), 0);
    eq(C.estimateTokens(null, 'kotlin'), 0);
});

test('estimateTokens: кириллица и JSON стоят больше токенов, чем обычный текст', () => {
    const latin = 'x'.repeat(4000);
    const cyrillic = 'ж'.repeat(4000);
    truthy(C.estimateTokens(cyrillic, 'markdown') > C.estimateTokens(latin, 'markdown'));
    truthy(C.estimateTokens(latin, 'json') > C.estimateTokens(latin, 'markdown'));
    eq(C.estimateTokens(latin, 'kotlin'), Math.ceil(4000 / 3.7));
});

test('estimateTokens: большая строка сэмплируется, а не читается целиком', () => {
    // 400 000 символов: хвост из кириллицы не должен утянуть оценку целиком
    const text = 'a'.repeat(396000) + 'ж'.repeat(4000);
    const estimate = C.estimateTokens(text, 'plain');
    truthy(estimate > 90000 && estimate < 115000, `оценка ${estimate}`);
});

/* ---------------- Фильтры ---------------- */
test('isAllowedExtension: список расширений', () => {
    const allowed = C.getAllowedExtensions('.kt, .XML ,');
    truthy(C.isAllowedExtension('Main.KT', allowed));
    truthy(C.isAllowedExtension('layout.xml', allowed));
    falsy(C.isAllowedExtension('Main.java', allowed));
    truthy(C.isAllowedExtension('anything.bin', new Set()), 'пустой список разрешает всё');
});

test('isAllowedExtension: файлы без расширения по имени', () => {
    const allowed = C.getAllowedExtensions('.dockerfile,.makefile,.gitignore');
    truthy(C.isAllowedExtension('Dockerfile', allowed));
    truthy(C.isAllowedExtension('Dockerfile.prod', allowed));
    falsy(C.isAllowedExtension('docker-compose.yml', allowed));
    truthy(C.isAllowedExtension('Makefile', allowed));
    truthy(C.isAllowedExtension('.gitignore', allowed));
    falsy(C.isAllowedExtension('.gitattributes', allowed));
});

test('hasHiddenSegment: точка в начале сегмента', () => {
    truthy(C.hasHiddenSegment('.git/config'));
    truthy(C.hasHiddenSegment('app/.github/w.yml'));
    truthy(C.hasHiddenSegment('.gitignore'));
    falsy(C.hasHiddenSegment('app/build.gradle.kts'));
    falsy(C.hasHiddenSegment('a.b/c'));
    falsy(C.hasHiddenSegment('init.lua'), 'корень проекта не считается — проверяется путь внутри него');
});

test('createIgnoreMatcher: имена сегментов, регистр, шаблоны', () => {
    const m = C.createIgnoreMatcher('build, node_modules, *.generated.kt, app/debug/*');
    truthy(m.test('build/x.class'));
    truthy(m.test('app/build/x.class'));
    truthy(m.test('app/Build/x.class'), 'регистр не важен');
    falsy(m.test('app/buildx/x.class'));
    falsy(m.test('x.java'));
    truthy(m.test('app/src/Foo.generated.kt'), 'шаблон по имени файла');
    truthy(m.test('app/debug/Main.kt'), 'шаблон с «/» — от корня');
    falsy(m.test('other/debug/Main.kt'));
    truthy(C.createIgnoreMatcher('  , ').isEmpty());
    falsy(C.createIgnoreMatcher('').test('anything'));
});

/* ---------------- .gitignore ---------------- */
test('gitignore: папка со слешем исключает всё внутри', () => {
    truthy(ignored('node_modules/\n', 'node_modules/react/index.js'));
    truthy(ignored('node_modules/\n', 'app/node_modules/react/index.js'));
    const m = C.createGitignoreMatcher();
    m.add('', 'node_modules/\n');
    truthy(m.isIgnored('node_modules', true));
    falsy(ignored('node_modules/\n', 'node_modules.txt'));
});

test('gitignore: шаблон без слеша — по имени на любом уровне, с ведущим слешем — только от корня', () => {
    truthy(ignored('*.log\n', 'a/b/c.log'));
    falsy(ignored('*.log\n', 'c.log.bak'));
    truthy(ignored('/build\n', 'build/out.class'));
    falsy(ignored('/build\n', 'app/build/out.class'));
    truthy(ignored('build\n', 'app/build/out.class'));
    truthy(ignored('doc/frotz/\n', 'doc/frotz/x'));
    falsy(ignored('doc/frotz/\n', 'a/doc/frotz/x'));
});

test('gitignore: «**», «?» и классы символов', () => {
    truthy(ignored('**/generated\n', 'a/b/generated/x'));
    truthy(ignored('**/generated\n', 'generated/x'));
    truthy(ignored('logs/**\n', 'logs/a/b.txt'));
    falsy(ignored('logs/**\n', 'logs.txt'));
    truthy(ignored('temp?\n', 'temp1'));
    falsy(ignored('temp?\n', 'temp12'));
    truthy(ignored('*.[oa]\n', 'lib/a.o'));
    falsy(ignored('*.[oa]\n', 'lib/a.cpp'));
});

test('gitignore: исключение «!» и приоритет последнего правила', () => {
    truthy(ignored('*.txt\n', 'keep.txt'));
    falsy(ignored('*.txt\n!keep.txt\n', 'keep.txt'));
    truthy(ignored('*.txt\n!keep.txt\n', 'other.txt'));
    falsy(ignored('logs/*\n!logs/keep/\n', 'logs/keep/a.txt'));
    truthy(ignored('logs/*\n!logs/keep/\n', 'logs/x/a.txt'));
});

test('gitignore: комментарии, пустые строки, вложенные .gitignore', () => {
    falsy(ignored('# build\n\n  \n', 'build/x'));
    const m = C.createGitignoreMatcher();
    m.add('', 'secret.txt\n');
    m.add('sub/', '!secret.txt\n');
    m.add('sub/', '*.tmp\n');
    truthy(m.isFileIgnored('secret.txt'));
    falsy(m.isFileIgnored('sub/secret.txt'), 'более глубокий .gitignore отменяет родительский');
    truthy(m.isFileIgnored('other/secret.txt'));
    truthy(m.isFileIgnored('sub/a.tmp'));
    falsy(m.isFileIgnored('a.tmp'), 'правило из sub/ не действует на корень');
});

test('gitignore: правило только-для-папок не скрывает файл с тем же именем', () => {
    falsy(ignored('build/\n', 'src/build'));
    truthy(ignored('build/\n', 'src/build/Main.kt'));
});

/* ---------------- Язык фильтра ---------------- */
const entry = (path, text, extra = {}) => ({ path, pathLower: path.toLowerCase(), name: path.split('/').pop(), ext: C.getExt(path.split('/').pop()), text, size: text.length, tokens: Math.ceil(text.length / 4), ...extra });
const match = (query, e) => C.matchesQuery(e, C.parseQuery(query));

test('parseQuery: слова и исключения по пути', () => {
    truthy(match('viewmodel test', entry('app/ViewModelTest.kt', '')));
    falsy(match('viewmodel -test', entry('app/ViewModelTest.kt', '')));
    truthy(match('viewmodel -test', entry('app/ViewModel.kt', '')));
    truthy(match('"two words"', entry('a/two words/x.txt', '')));
    truthy(match('', entry('anything', '')));
    truthy(match('foo:bar', entry('x/foo:bar.txt', '')), 'неизвестное поле — обычное слово');
});

test('parseQuery: содержимое, расширение, размер, токены, секреты', () => {
    truthy(match('c:Retrofit', entry('a/Api.kt', 'import retrofit2.Retrofit')));
    falsy(match('c:Retrofit', entry('a/Api.kt', 'class Api')));
    truthy(match('ext:xml', entry('res/layout/main.xml', '')));
    truthy(match('ext:.xml', entry('res/layout/main.xml', '')));
    falsy(match('ext:xml', entry('res/layout/main.xml.bak', '')));
    truthy(match('size>10kb', entry('a.bin', 'x'.repeat(20480))));
    falsy(match('size>10kb', entry('a.bin', 'x'.repeat(1024))));
    truthy(match('size<100', entry('a.bin', 'x'.repeat(50))));
    truthy(match('tokens<5', entry('a.bin', 'x'.repeat(12))));
    falsy(match('tokens<5', entry('a.bin', 'x'.repeat(80))));
    truthy(match('secret', entry('a.kt', '', { secrets: [{ line: 3 }] })));
    truthy(match('has:secret', entry('a.kt', '', { secrets: [{ line: 3 }] })));
    falsy(match('secret', entry('a.kt', '')));
    truthy(match('a -ext:kt', entry('a/Main.kt', '')) === false);
});

/* ---------------- Сортировка и дерево ---------------- */
test('sortFiles: стратегии сортировки', () => {
    const files = [file('b/10.kt', 'aaaa'), file('a/2.kt', 'aa'), file('a/10.kt', 'aaa')];
    deepEq(C.sortFiles(files, 'path-asc').map((f) => f.path), ['a/2.kt', 'a/10.kt', 'b/10.kt']);
    deepEq(C.sortFiles(files, 'path-desc').map((f) => f.path), ['b/10.kt', 'a/10.kt', 'a/2.kt']);
    deepEq(C.sortFiles(files, 'size-asc').map((f) => f.path), ['a/2.kt', 'a/10.kt', 'b/10.kt']);
    eq(files[0].path, 'b/10.kt', 'исходный массив не меняется');
});

test('buildAsciiTree: папки раньше файлов, естественный порядок', () => {
    const tree = C.buildAsciiTree([file('app/b.txt', ''), file('app/src/10.kt', ''), file('app/src/2.kt', ''), file('README.md', '')]);
    eq(tree, [
        '├── app/',
        '│   ├── src/',
        '│   │   ├── 2.kt',
        '│   │   └── 10.kt',
        '│   └── b.txt',
        '└── README.md',
    ].join('\n'));
});

/* ---------------- Сборка ---------------- */
test('planParts: без лимита — одна часть, файлы не режутся', () => {
    const files = [file('a.kt', 'x', { outTokens: 100 }), file('b.kt', 'y', { outTokens: 500 }), file('c.kt', 'z', { outTokens: 50 })];
    eq(C.planParts(files, {}).length, 1);
    const parts = C.planParts(files, { limitTokens: 400 });
    eq(parts.length, 3, 'каждый файл сам по себе: сумма любой пары превышает лимит');
    deepEq(parts.map((p) => p.files.map((f) => f.path)), [['a.kt'], ['b.kt'], ['c.kt']]);
});

test('planParts: части заполняются до лимита, oversized-файл получает свою часть', () => {
    const files = [];
    for (let i = 0; i < 10; i++) files.push(file(`f${i}.kt`, 'x', { outTokens: 100 }));
    files.push(file('big.kt', 'x', { outTokens: 5000 }));
    files.push(file('f10.kt', 'x', { outTokens: 100 }));
    const parts = C.planParts(files, { limitTokens: 500 });
    truthy(parts.length >= 3);
    const big = parts.find((p) => p.files.some((f) => f.path === 'big.kt'));
    eq(big.files.length, 1, 'файл больше лимита лежит один');
    for (const p of parts) truthy(p.files.length > 0, 'пустых частей нет');
    for (const p of parts.filter((x) => x !== big)) truthy(p.tokens <= 500, `часть в лимите: ${p.tokens}`);
    deepEq(parts.flatMap((p) => p.files.map((f) => f.path)), files.map((f) => f.path), 'порядок файлов сохранён');
});

test('planParts: лимит по байтам', () => {
    const files = [file('a', 'x'.repeat(600)), file('b', 'y'.repeat(600)), file('c', 'z'.repeat(10))];
    const parts = C.planParts(files, { limitBytes: 1000 });
    deepEq(parts.map((p) => p.files.length), [1, 2]);
    const files3 = [file('a', 'x'.repeat(600)), file('b', 'y'.repeat(600)), file('c', 'z'.repeat(400))];
    deepEq(C.planParts(files3, { limitBytes: 1000 }).map((p) => p.files.length), [1, 1, 1]);
    eq(C.planParts([], {}).length, 0);
});

test('renderFile: содержимое между ограждениями совпадает с файлом', () => {
    const chunks = C.renderFile(file('app/Main.kt', 'fun main() {\n    println(1)\n}\n'));
    eq(chunks.join(''), '\n<file path="app/Main.kt">\n```kotlin\nfun main() {\n    println(1)\n}\n```\n</file>\n');
    eq(C.renderFile(file('a.txt', 'no newline')).join(''), '\n<file path="a.txt">\n```\nno newline\n```\n</file>\n', 'без переноса в конце — добавляется один');
    eq(C.renderFile(file('empty.txt', '')).join(''), '\n<file path="empty.txt">\n```\n\n```\n</file>\n');
});

test('renderFile: ограждение длиннее самого длинного забора в файле, путь экранируется', () => {
    const text = 'text\n```kotlin\nval x = 1\n```\n````\n';
    eq(C.renderFile(file('doc.md', text)).join(''), `\n<file path="doc.md">\n\`\`\`\`\`markdown\n${text}\`\`\`\`\`\n</file>\n`);
    eq(C.getSafeFence('` `` ```'), '````');
    eq(C.getSafeFence(''), '```');
    truthy(C.renderFile(file('a"b<c>/&.txt', 'x')).join('').includes('<file path="a&quot;b&lt;c&gt;/&amp;.txt">'));
});

test('renderToc / renderMeta: три варианта оглавления и шапка', () => {
    const files = [file('app/a.kt', '')];
    eq(C.renderToc(files, 'none').join(''), '<toc>\n</toc>\n\n');
    truthy(C.renderToc(files, 'tree').join('').includes('Project structure (ASCII tree):\n└── app/\n    └── a.kt\n'));
    truthy(C.renderToc(files, 'tree-list').join('').includes('Files (flat list):\n- app/a.kt\n'));
    const meta = (opts) => C.renderMeta({ note: true, requested: 3, included: 2, skipped: [{ path: 'x.kt', error: 'boom' }], sorting: 'path-asc', tokens: 123, parts: 2, part: 1, from: 1, to: 2, generatedAt: '2026-01-01T00:00:00.000Z', ...opts });
    const text = meta({});
    truthy(text.startsWith('<bundle_meta>\nAttache v10.0 — a single-file bundle'));
    truthy(text.includes('Total files (requested): 3\nFiles included: 2\nFiles skipped (read error): 1\nSorting: path-asc\nEstimated tokens: ~123\nPart: 1 of 2 (files 1-2 of 2)\nGenerated at: 2026-01-01T00:00:00.000Z\nSkipped files (read error):\n- x.kt ::boom\n</bundle_meta>\n\n'));
    falsy(meta({ note: false }).includes('single-file bundle'));
    falsy(meta({ parts: 1, skipped: [] }).includes('Part:'), 'одна часть не подписывается');
});

test('partFileName: суффикс _partNofM перед расширением', () => {
    eq(C.partFileName('merged_context.txt', 1, 1), 'merged_context.txt');
    eq(C.partFileName('merged_context.txt', 2, 3), 'merged_context_part2of3.txt');
    eq(C.partFileName('context', 1, 2), 'context_part1of2');
    eq(C.partFileName('ctx.md', 3, 3), 'ctx_part3of3.md');
});

/* ---------------- Очистка комментариев и нумерация ---------------- */
test('transformText: нумерация строк', () => {
    eq(C.transformText('a\nb\nc', 'kotlin', { lineNumbers: true }), '1: a\n2: b\n3: c');
    eq(C.transformText('a\nbb\nccc', 'kotlin', { lineNumbers: true }), '1: a\n2: bb\n3: ccc');
    eq(C.transformText('a\nb\n', 'kotlin', { lineNumbers: true }), '1: a\n2: b\n', 'завершающий перенос сохраняется');
    eq(C.transformText('const t = `x\n\ny`;', 'javascript', { lineNumbers: true }), '1: const t = `x\n2: \n3: y`;', 'пустая строка внутри шаблонной строки нумеруется');
    eq(C.transformText('', 'kotlin', { lineNumbers: true }), '');
    eq(C.transformText('a // x', 'kotlin', {}), 'a // x', 'без флажков текст не меняется');
});

test('stripComments: Java — строки, блоки, документирующие комментарии', () => {
    const src = [
        '// header comment',
        'int x = 1; // trailing',
        'String url = "http://example.com"; // comment',
        'char q = \'"\';',
        '/* block',
        '   comment */',
        'final int y = 2; /* inline */ int z = 3;',
        '/**',
        ' * doc',
        ' */',
        'void m() {}',
        'int a = 1_000_000; // grouped digits',
        '',
        '',
    ].join('\n');
    eq(strip('java', src), [
        'int x = 1;',
        'String url = "http://example.com";',
        'char q = \'"\';',
        'final int y = 2; int z = 3;',
        'void m() {}',
        'int a = 1_000_000;',
        '',
        '',
    ].join('\n'));
    truthy(strip('java', src, { keepDoc: true }).includes('/**\n * doc\n */'), 'с keepDoc документирующий блок остаётся');
    falsy(strip('java', src, { keepDoc: true }).includes('// header'), 'обычный комментарий уходит и с keepDoc');
});

test('stripComments: вложенные блоки, времена жизни и сырые строки (Rust, Kotlin)', () => {
    eq(strip('rust', '/* a /* b */ c */ let x = 1;'), ' let x = 1;');
    eq(strip('rust', "fn f<'a>(x: &'a str) { // c\n    let s = r#\"a // not comment\"#; // real\n}"), "fn f<'a>(x: &'a str) {\n    let s = r#\"a // not comment\"#;\n}");
    eq(strip('kotlin', 'val s = """raw /* not */ string""" /* real */'), 'val s = """raw /* not */ string"""');
    eq(strip('kotlin', '/* outer /* inner */ still comment */ code'), ' code');
    eq(strip('kotlin', '/// not a doc comment in Kotlin\nval x = 1'), 'val x = 1');
});

test('stripComments: незакрытый блок не съедает файл', () => {
    eq(strip('java', 'int x = 1; /* unterminated'), 'int x = 1; /* unterminated');
    eq(strip('xml', '<a><!-- unterminated</a>'), '<a><!-- unterminated</a>');
});

test('stripComments: Python — shebang, docstring, решётка без пробела', () => {
    const src = [
        '#!/usr/bin/env python3',
        '# comment',
        'import os # trailing',
        'x = "# not a comment"; y = 1  # real',
        'def f():',
        '    """doc',
        '    string # kept"""',
        '    return 0',
        'z=1#nospace',
    ].join('\n');
    eq(strip('python', src), [
        '#!/usr/bin/env python3',
        'import os',
        'x = "# not a comment"; y = 1',
        'def f():',
        '    """doc',
        '    string # kept"""',
        '    return 0',
        'z=1#nospace',
    ].join('\n'));
});

test('stripComments: YAML — блочные скаляры не трогаются', () => {
    const src = [
        '# service definition',
        'services:',
        '  app:',
        '    image: nginx # latest',
        '    command: |',
        '      # this is data, not a comment',
        '      echo "hi"   # also data',
        '  health:',
        '    test: >-',
        '      curl -f http://localhost/#frag',
        '    url: http://x/#y',
        '#',
        '',
    ].join('\n');
    eq(strip('yaml', src), [
        'services:',
        '  app:',
        '    image: nginx',
        '    command: |',
        '      # this is data, not a comment',
        '      echo "hi"   # also data',
        '  health:',
        '    test: >-',
        '      curl -f http://localhost/#frag',
        '    url: http://x/#y',
        '',
    ].join('\n'));
});

test('stripComments: shell — heredoc, ${var#prefix}, shebang', () => {
    const src = [
        '#!/bin/bash',
        '# install',
        'cat <<EOF',
        '# not a comment',
        'EOF',
        'echo "${x#prefix}" # trailing',
        'echo $#',
        'echo a#b',
    ].join('\n');
    eq(strip('bash', src), [
        '#!/bin/bash',
        'cat <<EOF',
        '# not a comment',
        'EOF',
        'echo "${x#prefix}"',
        'echo $#',
        'echo a#b',
    ].join('\n'));
});

test('stripComments: SQL, XML, Markdown, Dockerfile, CSS, JS', () => {
    eq(strip('sql', "select a -- note\nfrom t /* c */ where b = '#'; \n-- tail"), "select a\nfrom t where b = '#'; \n");
    eq(strip('sql', "select data #> '{a}' from t"), "select data #> '{a}' from t", 'оператор #> PostgreSQL не комментарий');
    eq(strip('xml', '<a>\n  <!-- note -->\n  <b x="<!--"/>\n  <c/><!-- t -->\n</a>'), '<a>\n  <b x="<!--"/>\n  <c/>\n</a>');
    eq(strip('markdown', 'Title\n<!-- hidden note -->\ntext <!-- t --> more'), 'Title\ntext more');
    eq(strip('docker', '# base\nFROM alpine # not at start\nRUN apk add curl\n'), 'FROM alpine # not at start\nRUN apk add curl\n');
    eq(strip('css', 'a { color: red } /* c */\nb { } // not a comment in css'), 'a { color: red }\nb { } // not a comment in css');
    eq(strip('scss', 'a { } // c'), 'a { }');
    eq(strip('javascript', 'const u = "http://x"; // c\nconst t = `a\n// inside template\n`; /* b */ let z = 1;'), 'const u = "http://x";\nconst t = `a\n// inside template\n`; let z = 1;');
    eq(strip('csharp', 'string p = @"C:\\temp\\a.txt"; // c'), 'string p = @"C:\\temp\\a.txt";');
    eq(strip('csharp', 'string q = @"say ""hi"""; /* b */'), 'string q = @"say ""hi""";');
    eq(strip('swift', 'let r = #"a "b" c"# // c'), 'let r = #"a "b" c"#');
    eq(strip('properties', '# comment\n! also\nkey=value # not at start\n'), 'key=value # not at start\n');
    eq(strip('batch', '@echo off\nREM pause here\n:: another\nrename a b'), '@echo off\nrename a b');
    eq(strip('plain', '# no rules for plain text\nx = 1; // kept'), '# no rules for plain text\nx = 1; // kept');
});

test('stripComments: файл целиком из комментариев', () => {
    eq(strip('java', '// one\n/* two */\n// three\n'), '');
    eq(strip('yaml', '# a\n# b\n'), '');
});

test('stripComments: нумерация + очистка сохраняют исходные номера строк', () => {
    eq(strip('kotlin', 'a // one\n// two\nb\n/* three */\nc', { numbered: true }) .replace(/^/, '') && C.transformText('a // one\n// two\nb\n/* three */\nc', 'kotlin', { lineNumbers: true, stripComments: true }), '1: a\n3: b\n5: c');
    eq(C.transformText('key: v # c\n# whole\nother: 1', 'yaml', { lineNumbers: true, stripComments: true }), '1: key: v\n3: other: 1');
    eq(C.transformText('x\ny', 'kotlin', { lineNumbers: true, stripComments: true }), '1: x\n2: y');
});

/* ---------------- Секреты ---------------- */
test('findSecrets: известные форматы ключей', () => {
    const aws = C.findSecrets('line1\nkey = "AKIAIOSFODNN7EXAMPLE"', 'kotlin', 'a.kt');
    eq(aws[0].kind, 'AWS-ключ');
    eq(aws[0].line, 2);
    eq(C.findSecrets('AIzaSyA-1234567890abcdefghijklmnopqrstu', 'xml', 'a.xml')[0].kind, 'Google API key');
    eq(C.findSecrets('ghp_' + 'a'.repeat(36), 'plain', 'a.txt')[0].kind, 'GitHub-токен');
    truthy(C.findSecrets('-----BEGIN RSA PRIVATE KEY-----', 'plain', 'k.pem').length === 1);
    falsy('value' in C.findSecrets('AKIAIOSFODNN7EXAMPLE', 'plain', 'a')[0], 'само значение наружу не отдаётся');
});

test('findSecrets: пароли в коде и конфигах, без ложных срабатываний', () => {
    truthy(C.findSecrets('const val apiKey = "abc123def456ghi789"', 'kotlin', 'Config.kt').length);
    truthy(C.findSecrets('storePassword "changeme"', 'groovy', 'build.gradle').length, 'пароль подписи Gradle и «changeme» — находка, а не заглушка');
    truthy(C.findSecrets('"password": "s3cr3t-pass"', 'json', 'config.json').length);
    truthy(C.findSecrets('DB_PASSWORD=supersecret123', 'properties', '.env').length);
    truthy(C.findSecrets('password: my-secret-pass', 'yaml', 'docker-compose.yml').length);
    truthy(C.findSecrets('private_key: "-----BEGIN-----"', 'yaml', 'a.yml').length);

    eq(C.findSecrets('<string name="password">Пароль</string>', 'xml', 'strings.xml').length, 0, 'имя ресурса — не секрет');
    eq(C.findSecrets('android:inputType="textPassword"', 'xml', 'layout.xml').length, 0);
    eq(C.findSecrets('val passwordHint = "Минимум 8 символов"', 'kotlin', 'a.kt').length, 0, 'подсказка про пароль — не пароль');
    eq(C.findSecrets('val token = tokenManager.getAccessToken()', 'kotlin', 'a.kt').length, 0, 'вызов метода без кавычек — не значение');
    eq(C.findSecrets('password: ${VAULT_PASSWORD}', 'yaml', 'a.yml').length, 0, 'ссылка на переменную окружения');
    eq(C.findSecrets('db.url=jdbc:postgresql://localhost:5432/app', 'properties', 'app.properties').length, 0);
    eq(C.findSecrets('API_KEY=YOUR_API_KEY_HERE', 'properties', '.env').length, 0, 'заглушка из документации');
    eq(C.findSecrets('headers = { Authorization = "Bearer " + token }', 'kotlin', 'a.kt').length, 0);
    eq(C.findSecrets('', 'kotlin', 'a.kt').length, 0);
});

/* ---------------- Кодировки ---------------- */
test('inspectBytes: BOM задаёт кодировку, NUL — признак бинарных данных', () => {
    deepEq(C.inspectBytes(new Uint8Array([0x61, 0x62])), { binary: false, encoding: 'utf-8' });
    deepEq(C.inspectBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), { binary: false, encoding: 'utf-8' });
    deepEq(C.inspectBytes(new Uint8Array([0xff, 0xfe, 0x31, 0x00, 0x32, 0x00])), { binary: false, encoding: 'utf-16le' }, 'UTF-16 не считается бинарным');
    deepEq(C.inspectBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x31])), { binary: false, encoding: 'utf-16be' });
    deepEq(C.inspectBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), { binary: true, encoding: 'utf-8' });
    deepEq(C.inspectBytes(new Uint8Array([])), { binary: false, encoding: 'utf-8' });
});

/* ---------------- Лимиты моделей ---------------- */
test('getModelLimit: пресеты и своё значение', () => {
    eq(C.getModelLimit('none'), 0);
    eq(C.getModelLimit('gemini-1m'), 1048576);
    eq(C.getModelLimit('custom', '150000'), 150000);
    eq(C.getModelLimit('custom', 'мусор'), 0);
    eq(C.getModelLimit('unknown-id'), 0);
});

await run();
