import globals from 'globals';
import reviewableConfigBaseline from 'reviewable-configs/eslint-config/baseline.js';
import lodashConfigBaseline from 'reviewable-configs/eslint-config/lodash.js';

export default [
  ...reviewableConfigBaseline,
  ...lodashConfigBaseline,
  {
    files: ['*.js', 'fireplan'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
      ecmaVersion: 2024,
      sourceType: 'commonjs'
    }
  },
];
