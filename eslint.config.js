import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'data/', 'coverage/', 'src/generated/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // core/ — чистая логика: без Telegram, БД и файловой системы (CLAUDE.md, раздел 2)
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/pdf/poppler.ts', 'src/core/pdf/render.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['grammy', '@grammyjs/*'], message: 'core/ не знает о Telegram.' },
            {
              group: ['**/generated/**', '@prisma/*', '**/db/**'],
              message: 'core/ не обращается к БД.',
            },
            {
              group: ['**/delivery/**', '**/app/**'],
              message: 'core/ не зависит от внешних слоёв.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
