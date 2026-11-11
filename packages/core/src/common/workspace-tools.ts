export const WORKSPACE_TOOLS_PATH = '/services/cicerone/workspace-tools';

export interface FindOptions {
    /** Text to look for in file contents. Without it, files are listed by `glob`. */
    text?: string;
    regex?: boolean;
    glob?: string;
    /** Upper bound on returned lines. */
    max: number;
}

export interface FindResult {
    /** `path:line: text` for content matches, `path` for file listings; paths relative to the root. */
    lines: string[];
    /** How many there were before the cut. */
    total: number;
}

export interface RunResult {
    exitCode: number | null;
    /** stdout and stderr interleaved, middle elided when long. */
    output: string;
    durationMs: number;
    timedOut: boolean;
}

export const WorkspaceTools = Symbol('WorkspaceTools');
export interface WorkspaceTools {
    find(rootFsPath: string, options: FindOptions): Promise<FindResult>;
    run(cwdFsPath: string, command: string, timeoutMs: number): Promise<RunResult>;
}
