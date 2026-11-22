import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['node_modules/', '.wrangler/', 'worker-configuration.d.ts', '.pnpmfile.cjs'] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		// `const { SECRET, ...rest } = env` is how tests build an env without one key.
		rules: { '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, varsIgnorePattern: '^_' }] },
	},
	{
		// Server code logs through @ideasquared/log (see .claude/skills/logging).
		files: ['src/**/*.ts'],
		rules: { 'no-console': 'error' },
	},
);
