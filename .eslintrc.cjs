module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    browser: true
  },
  extends: [
    'eslint:recommended',
    'plugin:security/recommended-legacy'
  ],
  plugins: ['security'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script'
  },
  rules: {
    // Tighten key rules for production
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-console': 'off', // Allow console in Electron app
    'prefer-const': 'warn',
    'no-var': 'error',
    // `x != null` (null or undefined) is the one sanctioned loose comparison.
    'eqeqeq': ['error', 'always', { null: 'ignore' }],
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',

    // Security plugin overrides (reduce noise for Electron context)
    'security/detect-object-injection': 'off', // Too many false positives
    // An IDE reads and writes user-chosen paths by design; every renderer-
    // reachable path goes through utils/pathValidator instead.
    'security/detect-non-literal-fs-filename': 'off',
    'security/detect-child-process': 'warn',
    'security/detect-non-literal-regexp': 'off'
  },
  overrides: [
    {
      // Renderer files run in browser context
      files: ['src/renderer/**/*.js'],
      parserOptions: { sourceType: 'module' },
      env: {
        node: false,
        browser: true
      },
      globals: {
        CodeMirror: 'readonly',
        electronAPI: 'readonly',
        // CommonJS export guard used by a few renderer helpers for Jest.
        module: 'readonly'
      }
    },
    {
      // Command-line tools: ES modules for Node that share the simulator's code
      files: ['src/cli/**/*.js', 'bin/**/*.mjs'],
      parserOptions: { sourceType: 'module', ecmaVersion: 2024 },
      env: { node: true, browser: false }
    },
    {
      // Node ES module scripts (smoke test)
      files: ['scripts/**/*.mjs'],
      parserOptions: { sourceType: 'module', ecmaVersion: 2024 },
      env: { node: true, browser: false },
      // Node 22+ globals
      globals: { WebSocket: 'readonly', fetch: 'readonly' }
    },
    {
      // Impulse Cloud server, scripts and tests: Node ES modules
      files: ['cloud/src/**/*.js', 'cloud/scripts/**/*.js', 'cloud/test/**/*.js'],
      parserOptions: { sourceType: 'module', ecmaVersion: 2024 },
      env: { node: true, browser: false }
    },
    {
      // Impulse Cloud web pages (sign-in, admin)
      files: ['cloud/public/**/*.js'],
      parserOptions: { sourceType: 'module', ecmaVersion: 2024 },
      env: { node: false, browser: true }
    },
    {
      // Test files
      files: ['**/*.test.js', '**/*.spec.js', '**/__tests__/**/*.js'],
      parserOptions: { sourceType: 'module' },
      env: {
        jest: true
      }
    }
  ]
};
