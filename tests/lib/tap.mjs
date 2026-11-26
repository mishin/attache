// Минимальный раннер без зависимостей: test(имя, функция) в теле файла, await run() в конце.
// ATACHE_TEST_ONLY=<подстрока имени> — прогнать только часть тестов.
import assert from 'node:assert/strict';

const tests = [];
const filter = process.env.ATACHE_TEST_ONLY || '';

export function test(name, fn) {
    tests.push({ name, fn });
}

export async function run() {
    let failed = 0;
    let passed = 0;
    for (const t of tests) {
        if (filter && !t.name.includes(filter)) continue;
        try {
            await t.fn();
            passed++;
            console.log(`  ok   ${t.name}`);
        } catch (err) {
            failed++;
            console.log(`  FAIL ${t.name}`);
            console.log(`       ${String(err.message).split('\n').join('\n       ')}`);
        }
    }
    console.log(failed ? `\nПровалено: ${failed}, пройдено: ${passed}` : `\nВсе тесты пройдены: ${passed}`);
    if (failed) process.exitCode = 1;
    return failed;
}

const normalize = (v) => (Array.isArray(v) ? Array.from(v, normalize) : v && typeof v === 'object' && Object.getPrototypeOf(v) !== Object.prototype ? Object.fromEntries(Object.entries(v).map(([k, val]) => [k, normalize(val)])) : v);

export const eq = assert.equal;
export const notEq = assert.notEqual;
export const deepEq = (a, b, message) => assert.deepEqual(normalize(a), normalize(b), message);
export const ok = assert.ok;
export const truthy = (value, message) => assert.ok(value, message);
export const falsy = (value, message) => assert.ok(!value, message);
export const throws = assert.throws;
