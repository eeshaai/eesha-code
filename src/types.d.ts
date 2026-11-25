/*
 * Ambient declarations - shapes TypeScript has to be told about because
 * no `.ts` file declares them.
 *
 * A `.d.ts`, not a `.ts`: an ambient module declaration is only legal
 * in a declaration file. In a `.ts` it is read as an augmentation of a
 * module that must already exist, and fails with TS2664.
 */

/**
 * A stylesheet imported for its side effect - `import "./theme.scss"`.
 *
 * The `scss` plugin in `esbuild.js` compiles it to CSS beside the entry
 * point. TypeScript has no such loader, so without this the page
 * entry points fail the typecheck with TS2882.
 *
 * `.css` is declared too. Nothing imports one today, but the loader
 * reads them. No exports, because there is no value to name.
 */
declare module "*.css";
declare module "*.scss";
