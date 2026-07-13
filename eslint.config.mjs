// ESLint 9 flat config. eslint-config-next@16 ships a native flat-config
// array (core-web-vitals + typescript rules), so we spread it directly.
import next from "eslint-config-next";

const eslintConfig = [
  ...next,
  {
    ignores: [".next/**", "node_modules/**", "design/**"],
  },
];

export default eslintConfig;
