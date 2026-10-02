import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  { files: ['**/*.js'], ...eslint.configs.recommended },
  prettier,
];
