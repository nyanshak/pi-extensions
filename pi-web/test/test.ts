// Simple test framework for pi-web tests

export interface TestExpectation {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
  toBeTruthy: () => void;
  toBeFalsy: () => void;
  toContain: (item: unknown) => void;
  toThrow: () => void;
  not: {
    toBe: (expected: unknown) => void;
    toEqual: (expected: unknown) => void;
    toBeTruthy: () => void;
    toBeFalsy: () => void;
    toContain: (item: unknown) => void;
    toThrow: () => void;
  };
}

class Expectation implements TestExpectation {
  private actual: unknown;
  private negate: boolean;

  constructor(actual: unknown, negate = false) {
    this.actual = actual;
    this.negate = negate;
  }

  private check(condition: boolean): void {
    if (condition !== !this.negate) {
      const actualStr = JSON.stringify(this.actual);
      const op = this.negate ? "NOT" : "";
      throw new Error(`Expected ${op} ${actualStr}`);
    }
  }

  toBe(expected: unknown): void {
    this.check(this.actual === expected);
  }

  toEqual(expected: unknown): void {
    this.check(JSON.stringify(this.actual) === JSON.stringify(expected));
  }

  toBeTruthy(): void {
    this.check(!!this.actual === !this.negate);
  }

  toBeFalsy(): void {
    this.check(!this.actual === !this.negate);
  }

  toBeUndefined(): void {
    this.check(this.actual === undefined === !this.negate);
  }

  toContain(item: unknown): void {
    const has = Array.isArray(this.actual)
      ? this.actual.includes(item)
      : String(this.actual).includes(String(item));
    this.check(has);
  }

  toThrow(): void {
    let threw = false;
    try {
      if (typeof this.actual === "function") {
        (this.actual as () => void)();
      }
    } catch {
      threw = true;
    }
    this.check(threw === !this.negate);
  }

  get not(): TestExpectation {
    return new Expectation(this.actual, !this.negate) as TestExpectation;
  }
}

export function expect(actual: unknown): TestExpectation {
  return new Expectation(actual) as TestExpectation;
}

// Test suite tracking
let currentSuite = "unknown";
let currentTest = "";
let passed = 0;
let failed = 0;
const failures: { suite: string; test: string; error: string }[] = [];

export function describe(name: string, fn: () => void): void {
  const prevSuite = currentSuite;
  currentSuite = name;
  console.log(`\n  ${name}`);
  try {
    fn();
  } catch (err) {
    console.error(`    Suite error: ${err}`);
  }
  currentSuite = prevSuite;
}

export function it(name: string, fn: () => void | Promise<void>): void {
  currentTest = name;
  try {
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => {
          console.log(`    ✓ ${name}`);
          passed++;
        })
        .catch((err) => {
          console.log(`    ✗ ${name}`);
          failures.push({
            suite: currentSuite,
            test: currentTest,
            error: String(err),
          });
          failed++;
        });
    } else {
      console.log(`    ✓ ${name}`);
      passed++;
    }
  } catch (err) {
    console.log(`    ✗ ${name}`);
    failures.push({
      suite: currentSuite,
      test: currentTest,
      error: String(err),
    });
    failed++;
  }
}

export function beforeEach(fn: () => void | Promise<void>): void {
  // Placeholder for setup
}

export function afterEach(fn: () => void | Promise<void>): void {
  // Placeholder for teardown
}

// Run tests and report
export function run(): void {
  // Wait for any pending async tests
  setTimeout(() => {
    console.log(`\n${String.fromCharCode(0x2500).repeat(40)}`);
    console.log(`Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);

    if (failures.length > 0) {
      console.log(`\nFailures:`);
      for (const f of failures) {
        console.log(`  - ${f.suite} > ${f.test}`);
        console.log(`    ${f.error}`);
      }
    }

    process.exit(failed > 0 ? 1 : 0);
  }, 300);
}

// For named exports
export default { describe, it, expect, beforeEach, afterEach, run };