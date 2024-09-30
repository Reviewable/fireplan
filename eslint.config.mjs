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
        ...globals.es2018,
      },
      ecmaVersion: 2018,
      sourceType: 'commonjs'
    }
  },
];
