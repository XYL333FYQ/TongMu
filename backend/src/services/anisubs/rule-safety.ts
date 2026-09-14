const MAX_RULE_REGEX_LENGTH = 512;
export const MAX_RULE_SELECTOR_LENGTH = 2048;
export const MAX_RULE_RESULTS = 100;
export const MAX_RULE_SOURCES = 32;

// Guard common nested-quantifier/back-reference shapes that can make an
// imported rule spend unbounded time in JavaScript's regular-expression engine.
const NESTED_QUANTIFIER = /\([^()]{0,256}(?:[+*]|\{\d)[^()]{0,256}\)(?:[+*]|\{\d)/;
const BACK_REFERENCE = /\\\d/;

export function compileRuleRegex(pattern: unknown, flags = 'i'): RegExp | undefined {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_RULE_REGEX_LENGTH) {
    return undefined;
  }
  if (NESTED_QUANTIFIER.test(pattern) || BACK_REFERENCE.test(pattern)) return undefined;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
}

export function isSafeRuleUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RULE_SELECTOR_LENGTH) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isBoundedRuleText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_RULE_SELECTOR_LENGTH;
}
