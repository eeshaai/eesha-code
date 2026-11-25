/**
 * The layout of a `.eesha` folder, in one place, so the
 * workspace scan and the file watcher never disagree about what counts
 * as a workflow file.
 *
 * The same layout is valid in two scopes: a workspace's own folder, and
 * the user profile's `~/.eesha`. The workspace wins a clash
 * (see `mergeScopes`). Two entries are single-scope:
 *
 *   - `specs/` is workspace-only. A spec describes a change to this
 *     codebase, so a profile `specs/` would be read by nothing.
 *   - `db/` is profile-only. Run history is private and machine-local.
 */
export const WORKFLOWS_DIR = ".eesha";

/** Inline tasks, listed under Tasks. One file per scope, not a folder. */
export const TASKS_FILE = "tasks.yml";

/**
 * The engine's settings file - one per scope, and the only place the
 * engine reads configuration from. The workspace's is committed and
 * carries the team's settings; the profile's follows the person. Merged
 * per key, profile wins - see `mergeEngineSettings` in `core/settings`.
 */
export const SETTINGS_FILE = "settings.json";

/** Default-engine workflow definitions, one file each. */
export const WORKFLOWS_SUBDIR = "workflows";

/** User-written plugins: `<id>V<major>/` folders holding a `plugin.json`. */
export const PLUGINS_SUBDIR = "plugins";

/** SDD spec folders, one per feature. Workspace scope only. */
export const SPECS_SUBDIR = "specs";

/** The run database, one folder per workspace. Profile scope only. */
export const DB_SUBDIR = "db";

/**
 * Revise snapshots - the "before" copy a spec's document is compared
 * against. Profile scope only, for the same reason as `db/`.
 */
export const HISTORY_SUBDIR = "history";

/**
 * Daily log files, one per day across every workspace. Profile scope
 * only, for the same reason as `db/`.
 *
 * Eesha Code's own diagnostics only. What a run produced lives
 * under {@link EVENTS_SUBDIR}.
 */
export const LOGS_SUBDIR = "logs";

/**
 * Every line of every run, one JSONL file each, one folder per
 * workspace: `events/<workspace>/runs/<when>-<id>.jsonl` for a workflow
 * or task run, `events/<workspace>/specs/<name>.jsonl` for a spec.
 * Profile scope only, for the same reason as `db/`. See `runEvents.ts`
 * for why files rather than rows.
 */
export const EVENTS_SUBDIR = "events";

/**
 * Inline tasks, in any `.eesha` in the tree - so a monorepo
 * can keep `packages/api/.eesha/tasks.yml` beside the code it
 * builds. Only inside the folder, so unrelated files of the same name
 * are never picked up.
 */
export const TASKS_GLOB = `**/${WORKFLOWS_DIR}/${TASKS_FILE}`;

/**
 * Workflow definitions: a file anywhere under `workflows/`, sub-folders
 * included. The `**` also matches zero folders, so files directly in
 * `workflows/` are found.
 *
 * Whole patterns rather than a shared prefix with alternative tails, so
 * a caller combining this glob with another has flat pieces - see
 * {@link braced}.
 */
export const WORKFLOW_FILE_PATTERNS: readonly string[] = [
    `**/${WORKFLOWS_DIR}/${WORKFLOWS_SUBDIR}/**/*.yml`,
    `**/${WORKFLOWS_DIR}/${WORKFLOWS_SUBDIR}/**/*.yaml`
];

/**
 * Several patterns as one glob.
 *
 * Flat, never nested: the result goes to other glob matchers as well
 * as ours, and only a single level of alternatives is safe in both. A
 * nested `{a,{b,c}}` must stay impossible.
 */
export function braced(patterns: readonly string[]): string {

    return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

export const WORKFLOW_FILES_GLOB = braced(WORKFLOW_FILE_PATTERNS);
