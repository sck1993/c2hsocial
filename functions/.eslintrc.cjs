module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  globals: {
    document: "readonly",
    window: "readonly",
  },
  extends: ["eslint:recommended"],
  parserOptions: {
    ecmaVersion: "latest",
  },
  ignorePatterns: [
    "node_modules/",
    ".firebase/",
  ],
  rules: {
    "no-console": "off",
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "no-undef": "error",
    "eqeqeq": "off",
    "curly": "off",
    "no-empty": "warn",
    "no-control-regex": "off",
    "no-constant-condition": "off",
    "no-useless-escape": "off",
  },
};
