// Подключается только в тестах: загрузка CORE-блока из attache.html в Node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

export const APP_FILE = new URL('../../attache.html', import.meta.url);

/** Достаёт из attache.html блок CORE (чистая логика без DOM) и выполняет его в пустом контексте. */
export function loadCore() {
    const html = readFileSync(APP_FILE, 'utf8');
    const start = html.indexOf('const Core = (() => {');
    const endMarker = html.indexOf('END CORE', start);
    const end = html.lastIndexOf('})();', endMarker);
    if (start === -1 || endMarker === -1 || end === -1) throw new Error('В attache.html не найден блок CORE');
    return runInNewContext(`${html.slice(start, end + 5)}\n;Core`, Object.create(null));
}
