// Lints the browser code in ../../client with the same rules as the server,
// using the browser globals instead of Node's.
import js from "@eslint/js";
import eslintPluginUnicorn from "eslint-plugin-unicorn";
import { defineConfig } from "eslint/config";
import globals from "globals";

export default defineConfig([
  {
    files: ["client/**/*.js"],
    plugins: { js },
    extends: ["js/recommended", eslintPluginUnicorn.configs.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      "unicorn/filename-case": ["error", { cases: { camelCase: true } }],
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-null": "off",
      "unicorn/number-literal-case": "off",
      // Prettier formats the html`` templates.
      "unicorn/template-indent": "off",
    },
  },
]);
