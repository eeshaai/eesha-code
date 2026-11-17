const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const sass = require("sass");

/*
 * Builds Eesha Code into dist/:
 *
 *   cli.js            the command - start, stop, status, run
 *   server.js         the server the command starts in the background
 *   pluginWorker.js   the sandbox a user plugin runs in
 *   claude-agent-sdk/ the Claude Agent SDK's code file and its licence
 *   resources/styles/ SDD's built-in styles, read from disk
 *   web/              the page
 *
 * The Claude and Copilot programs are not shipped: the person's own
 * Claude Code and Copilot CLI are used, found on PATH. What ships is
 * only the code that drives them:
 *
 *   - the Copilot SDK is compiled into server.js. koffi, which it loads
 *     and which cannot be compiled in, is the package's one dependency;
 *   - the Claude Agent SDK is loaded with import() at run time and
 *     cannot be compiled in, so its one code file is copied beside
 *     server.js - see claudeSdkBeside.
 *
 * Source maps are written for debugging here. package.json leaves them
 * out of the npm package, because a map holds the original source.
 */

const out = path.join(__dirname, "dist");

// SDD's prompt files, compiled into the code.
const prompts = Object.fromEntries(
    ["first", "rewrite", "rewrite-note", "implement"].map(mode =>
        [mode, fs.readFileSync(path.join(__dirname, "resources", "styles", "custom", "prompts", mode + ".md"), "utf8")]));

// Compiles .scss with Sass and hands esbuild plain CSS.
const scss = {
    name: "scss",
    setup(build) {
        build.onLoad({ filter: /\.scss$/ }, file => {

            const result = sass.compile(file.path, {
                loadPaths: [path.dirname(file.path)],
                style: "expanded",
                sourceMap: false
            });

            return {
                contents: result.css,
                loader: "css",
                watchFiles: result.loadedUrls
                    .filter(url => url.protocol === "file:")
                    .map(url => url.pathname)
            };
        });
    }
};

// One copy of React, even when the UI library's own node_modules has one.
const oneReact = {
    react: path.join(__dirname, "node_modules", "react"),
    "react-dom": path.join(__dirname, "node_modules", "react-dom")
};

const shared = {
    bundle: true,
    sourcemap: true,
    define: {
        __SDD_PROMPTS__: JSON.stringify(prompts)
    }
};

const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk";

const runtimeDependencies = ["@github/copilot", "koffi", CLAUDE_SDK];

const claudeSdkFolder = path.join(__dirname, "node_modules", "@anthropic-ai", "claude-agent-sdk");

/*
 * Points the code's import() of the Claude Agent SDK at the copy beside
 * server.js. Looked up by name, the SDK would have to be installed by
 * npm as a dependency, and npm then also installs its large Claude
 * program, which is not wanted.
 */
const claudeSdkBeside = {
    name: "claude-sdk-beside",
    setup(build) {
        build.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
            path: "./claude-agent-sdk/sdk.mjs",
            external: true
        }));
    }
};

// Minified. keepNames keeps function and class names, so a stack trace
// in the log still says where it failed.
const node = {
    ...shared,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: runtimeDependencies.filter(name => name !== CLAUDE_SDK),
    plugins: [claudeSdkBeside],
    minify: true,
    keepNames: true
};

const builds = [
    {
        ...node,
        entryPoints: [path.join(__dirname, "src", "server", "cli.ts")],
        outfile: path.join(out, "cli.js"),
        banner: { js: "#!/usr/bin/env node" }
    },
    {
        ...node,
        entryPoints: [path.join(__dirname, "src", "server", "server.ts")],
        outfile: path.join(out, "server.js")
    },
    {
        ...shared,
        entryPoints: [path.join(__dirname, "src", "core", "plugins", "sandbox", "pluginWorker.ts")],
        outfile: path.join(out, "pluginWorker.js"),
        platform: "node",
        format: "cjs"
    },
    {
        ...shared,
        entryPoints: [path.join(__dirname, "src", "web", "index.tsx")],
        outdir: path.join(out, "web"),
        entryNames: "page",
        chunkNames: "chunks/[name]-[hash]",
        format: "esm",
        splitting: true,
        platform: "browser",
        minify: true,
        alias: oneReact,
        plugins: [scss]
    }
];

async function main() {

    fs.rmSync(out, { recursive: true, force: true });

    for (const options of builds)
        await esbuild.build(options);

    fs.copyFileSync(path.join(__dirname, "src", "web", "index.html"), path.join(out, "web", "index.html"));

    fs.mkdirSync(path.join(out, "claude-agent-sdk"));

    for (const file of ["sdk.mjs", "LICENSE.md"])
        fs.copyFileSync(path.join(claudeSdkFolder, file), path.join(out, "claude-agent-sdk", file));

    fs.cpSync(path.join(__dirname, "resources", "styles"), path.join(out, "resources", "styles"), { recursive: true });

    fs.copyFileSync(path.join(__dirname, "THIRD-PARTY-NOTICES.md"), path.join(out, "THIRD-PARTY-NOTICES.md"));

    console.log(`Built into ${out}`);
}

main().catch(error => {

    console.error(error);
    process.exit(1);
});
