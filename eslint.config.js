// Flat ESLint configuration.
//
// Type-aware linting is enabled for source and tests: the rules that matter
// most here — no floating promises, no unsafe member access on `any` — cannot
// be enforced without type information.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'src/web/public/**',
      'tests/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The agent reports its own startup, shutdown and collection failures
      // on stdout and stderr.
      'no-console': 'off',

      // System data is parsed, never asserted. Angle-bracket assertions and
      // assertions onto object literals are refused outright.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  {
    // The dashboard runs in a browser, not in Node.
    files: ['src/web/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Configuration and build scripts are plain JavaScript and are not part
    // of the TypeScript program, so type-aware rules cannot apply to them.
    // This must come before the globals below: `disableTypeChecked` carries
    // its own `languageOptions`, and merging it afterwards would discard
    // the ones set here.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // They run in Node, so `process`, `console` and the rest are defined.
    files: ['**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
