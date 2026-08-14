/// <reference types="@vellumai/plugin-api/app" />

// The builder emits `src/styles.css` as `main.css` and injects the <link> into
// index.html. The import in main.tsx exists so esbuild picks the file up; it has
// no runtime value, so it only needs a module declaration for the type checker.
declare module "*.css";
