import base from "./base.js";

export default [
    ...base,
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "warn",
        },
    },
    {
        ignores: [".next/", "node_modules/"],
    },
];
