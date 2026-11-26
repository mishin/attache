// End-to-end тесты attache.html в реальном Chromium через CDP. Запуск: node tests/e2e.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, run, eq, truthy, falsy } from './lib/tap.mjs';
import { Browser, startStaticServer, sleep } from './lib/cdp.mjs';

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function createFixtureProject() {
    const base = mkdtempSync(join(ROOT_DIR, 'tests', '.tmp-'));
    const proj = join(base, 'demo-app');
    mkdirSync(join(proj, 'src', 'main'), { recursive: true });
    mkdirSync(join(proj, 'src', 'test'), { recursive: true });
    mkdirSync(join(proj, 'build'), { recursive: true });
    mkdirSync(join(proj, '.git'), { recursive: true });

    writeFileSync(join(proj, '.gitignore'), '*.log\nignored_dir/\n');
    writeFileSync(join(proj, '.git', 'config'), '[core]\n');
    writeFileSync(join(proj, 'build', 'Out.kt'), 'class Out\n');
    mkdirSync(join(proj, 'ignored_dir'), { recursive: true });
    writeFileSync(join(proj, 'ignored_dir', 'Skip.kt'), 'class Skip\n');
    writeFileSync(join(proj, 'app.log'), 'log line\n');

    writeFileSync(join(proj, 'src', 'main', 'App.kt'), [
        '// header comment',
        'package demo',
        '',
        'fun main() {',
        '    println("hello") // trailing',
        '}',
    ].join('\n'));
    writeFileSync(join(proj, 'src', 'main', 'Secrets.kt'), 'val apiKey = "AKIAIOSFODNN7EXAMPLE"\n');
    writeFileSync(join(proj, 'src', 'test', 'AppTest.kt'), 'class AppTest { fun ok() {} }\n');
    writeFileSync(join(proj, 'src', 'main', 'BigA.kt'), 'package demo\n// A\n' + 'val itemA = "value"\n'.repeat(160));
    writeFileSync(join(proj, 'src', 'main', 'BigB.kt'), 'package demo\n// B\n' + 'val itemB = "value"\n'.repeat(160));
    writeFileSync(join(proj, 'README.md'), '# Demo\n\n```kotlin\nval x = 1\n```\n');
    writeFileSync(join(proj, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]));

    return { base, proj };
}

const server = await startStaticServer(ROOT_DIR);
const browser = await Browser.launch({ headless: true });
const fixture = createFixtureProject();

try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/attache.html`);
    await page.eval('!!window.Attache');

    test('инициализация: интерфейс готов, пресеты и модели заполнены, тема переключается', async () => {
        const info = await page.eval(`(() => ({
            title: document.title,
            presets: document.querySelectorAll('#presets .preset-btn').length,
            models: document.querySelectorAll('#model option').length,
            theme: document.documentElement.dataset.theme,
            welcomeVisible: !document.getElementById('welcome-card').hidden,
            filesHidden: document.getElementById('files-card').hidden,
        }))()`);
        truthy(info.title.includes('Attache'));
        truthy(info.presets >= 6);
        truthy(info.models >= 7);
        eq(info.theme, 'dark');
        truthy(info.welcomeVisible);
        truthy(info.filesHidden);

        await page.eval(`document.getElementById('theme-btn').click()`);
        eq(await page.eval(`document.documentElement.dataset.theme`), 'light');
        await page.eval(`document.getElementById('theme-btn').click()`);
        await page.eval(`document.getElementById('theme-btn').click()`);
        eq(await page.eval(`document.documentElement.dataset.theme`), 'dark');
    });

    test('загрузка папки через input[webkitdirectory]: фильтрация, gitignore, бинарники, секреты', async () => {
        await page.setFiles('#file-input', [fixture.proj]);
        await sleep(350);

        const loaded = await page.eval(`(() => ({
            project: document.getElementById('project-name').textContent,
            paths: Attache.state.files.map((f) => f.path).sort(),
            welcomeHidden: document.getElementById('welcome-card').hidden,
            filesVisible: !document.getElementById('files-card').hidden,
            secretVisible: !document.getElementById('secret-banner').hidden,
            skippedSummary: document.getElementById('skipped-summary').textContent,
        }))()`);

        eq(loaded.project, 'demo-app');
        truthy(loaded.welcomeHidden);
        truthy(loaded.filesVisible);
        truthy(loaded.secretVisible);
        eq(loaded.paths.join(','), 'README.md,src/main/App.kt,src/main/BigA.kt,src/main/BigB.kt,src/main/Secrets.kt,src/test/AppTest.kt');
        truthy(loaded.skippedSummary.includes('Пропущено'));
    });

    test('поиск-фильтр, чипы расширений, массовые действия и дерево папок', async () => {
        await page.eval(`(() => {
            const s = document.getElementById('search-input');
            s.value = '-test c:println';
            s.dispatchEvent(new Event('input'));
        })()`);
        await sleep(160);

        const rows = await page.eval(`Array.from(document.querySelectorAll('#file-list .file-row')).map((r) => r.dataset.path)`);
        eq(rows.join(','), 'src/main/App.kt');

        await page.eval(`document.getElementById('bulk-only').click()`);
        const activeAfterOnly = await page.eval(`Attache.state.files.filter((f) => !Attache.state.excludedPaths.has(f.path)).map((f) => f.path)`);
        eq(activeAfterOnly.join(','), 'src/main/App.kt');

        await page.eval(`(() => {
            const s = document.getElementById('search-input');
            s.value = '';
            s.dispatchEvent(new Event('input'));
        })()`);
        await sleep(160);
        await page.eval(`document.getElementById('bulk-include').click()`);

        await page.eval(`document.querySelector('#view-toggle button[data-view="tree"]').click()`);
        const treeHasSrc = await page.eval(`document.getElementById('tree-view').textContent.includes('src')`);
        truthy(treeHasSrc);
        await page.eval(`document.querySelector('#view-toggle button[data-view="list"]').click()`);
    });

    test('баннер секретов: маскирование, фильтр и исключение подозрительных файлов', async () => {
        await page.eval(`document.getElementById('secret-mask-btn').click()`);
        const maskState = await page.eval(`(() => {
            const f = Attache.state.files.find((x) => x.path === 'src/main/Secrets.kt');
            const active = Attache.state.files.filter((x) => !Attache.state.excludedPaths.has(x.path));
            const res = Attache.buildParts(active);
            return {
                setting: Attache.settings.maskSecrets,
                checkbox: document.getElementById('opt-mask-secrets').checked,
                outText: f.outText,
                bundleText: res.parts.map((p) => p.text).join('\\n'),
                hasSecretWarn: res.warnings.some((w) => w.includes('секретами')),
            };
        })()`);
        truthy(maskState.setting);
        truthy(maskState.checkbox);
        truthy(maskState.outText.includes('[REDACTED:AWS-ключ]'));
        falsy(maskState.bundleText.includes('AKIAIOSFODNN7EXAMPLE'));
        falsy(maskState.hasSecretWarn, 'с маскированием предупреждение о незащищённых секретах не мешает');

        // Выключаем маскирование и проверяем исключение файла кнопкой «Исключить»
        await page.eval(`document.getElementById('secret-mask-btn').click()`);
        falsy(await page.eval(`Attache.settings.maskSecrets`));

        await page.eval(`document.getElementById('secret-exclude-btn').click()`);
        const secretExcluded = await page.eval(`Attache.state.excludedPaths.has('src/main/Secrets.kt')`);
        truthy(secretExcluded);
        const bannerHidden = await page.eval(`document.getElementById('secret-banner').hidden`);
        truthy(bannerHidden);
    });

    test('предпросмотр кода, подсветка и режим «Как в итоге» с очисткой комментариев', async () => {
        await page.eval(`Attache.setSetting('lineNumbers', true)`);
        await page.eval(`Attache.setSetting('stripComments', true)`);
        await page.eval(`document.querySelector('.file-row[data-path="src/main/App.kt"] .file-path').click()`);

        const preview = await page.eval(`(() => ({
            open: !document.getElementById('preview-modal').hidden,
            title: document.getElementById('preview-title').textContent,
            hasKeywords: document.querySelectorAll('#preview-code .tok-keyword').length > 0,
        }))()`);
        truthy(preview.open);
        eq(preview.title, 'src/main/App.kt');
        truthy(preview.hasKeywords);

        await page.eval(`document.getElementById('preview-bundle-btn').click()`);
        const bundlePreviewText = await page.eval(`document.getElementById('preview-code').textContent`);
        falsy(bundlePreviewText.includes('header comment'));
        truthy(bundlePreviewText.includes('2'));
        await page.eval(`document.getElementById('preview-close').click()`);
    });

    test('сборка и разбивка на части, безопасное ограждение и модалка результата', async () => {
        await page.eval(`Attache.setSetting('lineNumbers', false)`);
        await page.eval(`Attache.setSetting('stripComments', false)`);
        await page.eval(`Attache.setSetting('split', 'tokens')`);
        await page.eval(`Attache.setSetting('splitTokens', 1000)`);

        const built = await page.eval(`(() => {
            const active = Attache.state.files.filter((f) => !Attache.state.excludedPaths.has(f.path));
            const res = Attache.buildParts(active);
            return {
                count: res.parts.length,
                joined: res.parts.map((p) => p.text).join('\\n---\\n'),
                firstMeta: res.parts[0].text.slice(0, 200),
            };
        })()`);
        truthy(built.count >= 2);
        truthy(built.firstMeta.includes('<bundle_meta>'));
        truthy(built.joined.includes('<toc>'));
        truthy(built.joined.includes('````markdown'));

        await page.eval(`document.getElementById('merge-btn').click()`);
        const modalInfo = await page.eval(`(() => ({
            open: !document.getElementById('result-modal').hidden,
            partCards: document.querySelectorAll('#result-parts .part').length,
        }))()`);
        truthy(modalInfo.open);
        eq(modalInfo.partCards, built.count);
        await page.eval(`document.querySelector('#result-modal [data-close="result-modal"]').click()`);
    });

    test('пользовательские пресеты: сохранение и удаление', async () => {
        await page.eval(`document.getElementById('btn-save-preset').click()`);
        await page.eval(`(() => {
            document.getElementById('preset-name').value = 'Мой пресет';
            document.getElementById('preset-form').dispatchEvent(new Event('submit', { cancelable: true }));
        })()`);
        const saved = await page.eval(`'Мой пресет' in Attache.settings.userPresets`);
        truthy(saved);
        await page.eval(`document.querySelector('.preset-btn.user .preset-delete').click()`);
        const afterDelete = await page.eval(`'Мой пресет' in Attache.settings.userPresets`);
        falsy(afterDelete);
    });

    test('инструкция / промпт для нейросети: шаблоны, подсчёт токенов и включение в части', async () => {
        const beforeTokens = await page.eval(`parseInt(document.getElementById('stat-tokens').textContent.replace(/\\s+/g, ''), 10)`);
        await page.eval(`(() => {
            const sel = document.getElementById('prompt-template');
            sel.value = 'java-es';
            sel.dispatchEvent(new Event('change'));
        })()`);

        const afterSelect = await page.eval(`(() => ({
            text: document.getElementById('prompt-text').value,
            badge: document.getElementById('prompt-badge').textContent,
            tokens: parseInt(document.getElementById('stat-tokens').textContent.replace(/\\s+/g, ''), 10),
        }))()`);
        truthy(afterSelect.text.includes('Elasticsearch'));
        truthy(afterSelect.badge.includes('ток.'));
        truthy(afterSelect.tokens > beforeTokens, 'токены инструкции учтены в общей статистике');

        // По умолчанию инструкция попадает только в 1-ю часть
        const partCheck1 = await page.eval(`(() => {
            const active = Attache.state.files.filter((f) => !Attache.state.excludedPaths.has(f.path));
            const res = Attache.buildParts(active);
            return {
                len: res.parts.length,
                p1Has: res.parts[0].text.startsWith('<instructions>'),
                p2Has: res.parts[1] ? res.parts[1].text.includes('<instructions>') : false,
            };
        })()`);
        truthy(partCheck1.len >= 2);
        truthy(partCheck1.p1Has);
        falsy(partCheck1.p2Has);

        // С галочкой «в каждую часть» инструкция попадает во все части
        await page.eval(`(() => {
            const cb = document.getElementById('opt-prompt-all-parts');
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
        })()`);
        const partCheckAll = await page.eval(`(() => {
            const active = Attache.state.files.filter((f) => !Attache.state.excludedPaths.has(f.path));
            const res = Attache.buildParts(active);
            return res.parts.every((p) => p.text.startsWith('<instructions>'));
        })()`);
        truthy(partCheckAll);

        // Очистка промпта
        await page.eval(`document.getElementById('btn-clear-prompt').click()`);
        eq(await page.eval(`document.getElementById('prompt-text').value`), '');
        eq(await page.eval(`document.getElementById('prompt-template').value`), 'none');
    });

    test('отсутствие ошибок в консоли браузера', async () => {
        eq(page.errors.length, 0, `Ошибки страницы: ${page.errors.join('; ')}`);
    });

    await run();
} finally {
    await browser.close();
    await server.close();
    rmSync(fixture.base, { recursive: true, force: true });
}
