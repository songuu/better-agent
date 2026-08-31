import { type RunCoreErrorCode, failRunCore } from './errors.js';

const postgresInstantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const postgresMinimumIsoYear = 1;
const postgresMaximumIsoYear = 9_999;
const postgresMaximumNumericOffsetMinutes = 15 * 60 + 59;

export function readPostgresInstantMicroseconds(
  value: string,
  path: string,
  code: RunCoreErrorCode = 'RUN_STATE_INVALID',
): bigint {
  const match = postgresInstantPattern.exec(value);
  if (match === null) {
    failRunCore(code, path, 'expected an ISO 8601 instant with an explicit UTC offset');
  }
  const year = Number(match[1]);
  if (!Number.isInteger(year) || year < postgresMinimumIsoYear || year > postgresMaximumIsoYear) {
    failRunCore(code, path, 'timestamp year is outside the supported ISO range');
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (daysInMonth[month - 1] ?? 0)) {
    failRunCore(code, path, 'timestamp contains an invalid Gregorian calendar date');
  }
  const offset = match[8];
  if (offset === undefined) {
    failRunCore(code, path, 'expected an ISO 8601 instant with an explicit UTC offset');
  }
  if (offset !== 'Z') {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    const totalOffsetMinutes = offsetHours * 60 + offsetMinutes;
    if (
      !Number.isInteger(offsetHours) ||
      !Number.isInteger(offsetMinutes) ||
      offsetMinutes > 59 ||
      totalOffsetMinutes > postgresMaximumNumericOffsetMinutes
    ) {
      failRunCore(code, path, 'numeric UTC offset exceeds PostgreSQL maximum of 15:59');
    }
  }
  const fraction = match[7] ?? '';
  if (fraction.length > 6) {
    failRunCore(code, path, 'timestamp precision exceeds PostgreSQL microseconds');
  }
  const epochMilliseconds = Date.parse(value);
  if (!Number.isFinite(epochMilliseconds)) {
    failRunCore(code, path, 'expected a valid ISO 8601 instant');
  }

  // Date.parse preserves only milliseconds. Add the remaining three digits so
  // equality matches PostgreSQL timestamptz's durable microsecond precision.
  const microsecondRemainder = fraction.padEnd(6, '0').slice(3, 6);
  return BigInt(epochMilliseconds) * 1_000n + BigInt(microsecondRemainder);
}
