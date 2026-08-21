// @ts-check
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

/**
 * Flat config (ESLint 9). This is a straight port of the previous
 * `.eslintrc.js` — the same two shareable configs and the same four rule
 * overrides — so the upgrade does not silently change what lint enforces.
 * Deliberately NOT extending `eslint.configs.recommended` or
 * `recommendedTypeChecked`: neither was enabled before, and turning them on
 * here would be a lint-policy change wearing a dependency bump's clothes.
 */
export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // typescript-eslint v8 flipped this rule's `caughtErrors` default from
      // 'none' to 'all', which would newly flag every unused `catch (error)`
      // binding. Pinning it back to 'none' keeps the dependency bump from
      // doubling as a lint-policy change; tightening it is a separate cleanup.
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },
);
