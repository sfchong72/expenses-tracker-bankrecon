import parser from "eslint-config-next/parser.js";

export default [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      parser,
      parserOptions: {
        requireConfigFile: false,
        sourceType: "module",
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        babelOptions: {
          parserOpts: {
            plugins: ["jsx", "typescript"],
          },
        },
      },
    },
  },
];
