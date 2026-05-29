// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Root ESLint flat configuration for the blitzy-slack pnpm workspace.
 *
 * The workspace `lint` script runs `eslint . --max-warnings 0`, so any rule
 * below that emits a warning fails the build (Rule 3 — Zero-Warning Build).
 * Type-aware linting is supplied by typescript-eslint v8's project service.
 * JavaScript config files, and TypeScript files that are not members of any
 * package tsconfig (root `*.config.ts`, `scripts/**`), are linted without
 * type information; all syntactic (non-type-aware) rules still apply to them.
 *
 * Configuration blocks are evaluated in order — later blocks override earlier
 * ones for files they match. `prettierConfig` is intentionally last so it can
 * disable any stylistic rule that would conflict with Prettier.
 */
export default tseslint.config(
  // 1. Global ignores: build artifacts, dependencies, generated and vendored code.
  //    The shadcn/ui primitives are copied verbatim and owned upstream, so they
  //    are not linted against project rules.
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/db/src/generated/**',
      'packages/db/prisma/migrations/**',
      'packages/web/src/components/ui/**',
    ],
  },

  // 2. ESLint core recommended rules for JavaScript.
  js.configs.recommended,

  // 3 & 4. typescript-eslint recommended + stylistic rule sets, with type checking.
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // 5. Workspace-wide language options. `projectService: true` enables the
  //    type-aware service for files that belong to a package tsconfig; the
  //    globals describe the runtime identifiers available across the workspace.
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // 6. React, hooks, fast-refresh and accessibility rules — scoped to the web
  //    package's source tree, where the React components live. The web `test/`
  //    tree holds Playwright E2E specs (whose `use()` fixture callback is not a
  //    React hook), so React rules deliberately do not reach it.
  {
    files: ['packages/web/src/**/*.{ts,tsx,js,jsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      ...jsxA11y.configs.recommended.rules,
    },
  },

  // 7. Workspace-wide rule overrides that enforce Rule 3.
  {
    rules: {
      // Rule 3 forbids `@ts-ignore`, `@ts-expect-error`, and `@ts-nocheck`.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-expect-error': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],
      // Unused variables, arguments and caught errors are errors; an underscore
      // prefix marks an intentionally unused binding.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // `console.log`/`console.debug` warn (and therefore fail the zero-warning
      // build); structured diagnostics use `warn`/`error`/`info`.
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },

  // 8. Test files relax the strictest rules so fixtures and assertions stay ergonomic.
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  // 9. JavaScript config files, root `*.config.ts`, `scripts/**`, and the Prisma
  //    `db seed` delegate (`**/prisma/seed.ts`) are not members of any package
  //    tsconfig, so type-aware rules cannot run on them. Disable type checking
  //    for these files while keeping all syntactic rules.
  {
    files: ['**/*.{js,cjs,mjs}', '*.config.ts', 'scripts/**/*.ts', '**/prisma/seed.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  // 10. Disable ESLint rules that conflict with Prettier. MUST remain last so
  //     Prettier owns every formatting decision (.prettierrc is the source).
  prettierConfig,
);
