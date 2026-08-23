import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "module",
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            camelcase: "error",
            "@typescript-eslint/explicit-function-return-type": "off",
            "@typescript-eslint/no-explicit-any": "error",
            "no-empty-function": "off",
            "@typescript-eslint/no-empty-function": "off",
        },
    },
    eslintConfigPrettier,
    {
        // Vendored minified bundles (e.g. Chart.js) are committed as-is and
        // must never be linted or reformatted.
        ignores: ["dist/", "node_modules/", "**/vendor/"],
    },
];
