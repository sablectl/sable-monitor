/**
 * The released version.
 *
 * It is a constant rather than a read of `package.json`, so that the
 * compiled output does not depend on a file outside `dist`. A unit test
 * asserts that the two agree, which is what keeps it honest.
 */
export const VERSION = '1.0.0';
