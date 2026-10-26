export type Response =
  | { outcome: 'repeat' }
  | { outcome: 'complete' }
  | { outcome: 'blocked'; blocker_text: string }
  | { outcome: 'fail'; failure_summary: string };

export type Violation = { kind: 'violation' };

const violation: Violation = { kind: 'violation' };

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseResponse(text: string): Response | Violation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return violation;
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return violation;
  }

  const object = value as Record<string, unknown>;
  switch (object.outcome) {
    case 'repeat':
    case 'complete':
      return hasOnlyKeys(object, ['outcome']) ? { outcome: object.outcome } : violation;
    case 'blocked':
      return hasOnlyKeys(object, ['outcome', 'blocker_text'])
        && typeof object.blocker_text === 'string'
        && object.blocker_text.length > 0
        ? { outcome: 'blocked', blocker_text: object.blocker_text }
        : violation;
    case 'fail':
      return hasOnlyKeys(object, ['outcome', 'failure_summary'])
        && typeof object.failure_summary === 'string'
        && object.failure_summary.length > 0
        ? { outcome: 'fail', failure_summary: object.failure_summary }
        : violation;
    default:
      return violation;
  }
}
