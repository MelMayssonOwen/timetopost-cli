import { CliError } from './api.js';
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
function tzOffsetMs(utcMs, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
    return asUtc - Math.floor(utcMs / 1000) * 1000;
}
/**
 * Parse --at. A value with Z or an explicit offset is taken literally. A bare
 * local date-time ("2026-11-02T09:30") is read in --tz when given, otherwise in
 * the machine's local timezone. Returns a UTC ISO string.
 */
export function parseAt(value, tz, now = Date.now()) {
    let ms;
    if (HAS_OFFSET.test(value)) {
        ms = new Date(value).getTime();
    }
    else {
        const m = NAIVE.exec(value);
        if (!m)
            throw new CliError(`Invalid --at "${value}". Use ISO 8601, e.g. 2026-11-02T09:30:00+01:00 or 2026-11-02T09:30 with --tz Europe/Madrid.`);
        const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
        if (tz) {
            try {
                new Intl.DateTimeFormat('en-US', { timeZone: tz });
            }
            catch {
                throw new CliError(`Unknown timezone "${tz}". Use an IANA name such as Europe/Madrid.`);
            }
            const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
            let result = guess - tzOffsetMs(guess, tz);
            result = guess - tzOffsetMs(result, tz);
            ms = result;
        }
        else {
            ms = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
        }
    }
    if (Number.isNaN(ms))
        throw new CliError(`Invalid --at "${value}".`);
    if (ms <= now)
        throw new CliError(`--at must be in the future (got ${new Date(ms).toISOString()}).`);
    return new Date(ms).toISOString();
}
