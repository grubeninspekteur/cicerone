/**
 * The tour is how the agent shows its work: an ordered list of stops the human steps through.
 * A stop is produced as a side effect of the agent working (an edit, a pointer, a command), never
 * as a separate report, so the tour cannot drift from what actually happened.
 */
export type StopKind = 'change' | 'context' | 'result';

/** `stale`: the text the change was written against is no longer there. */
export type StopState = 'pending' | 'accepted' | 'rejected' | 'stale';

export interface Stop {
    readonly id: string;
    readonly tourId: string;
    /** 1-based position within the tour. */
    readonly n: number;
    readonly kind: StopKind;
    /** The agent's one-line reason; rendered as markdown. */
    readonly why: string;
    /** File the stop is about (string form of the URI); absent for results. */
    readonly uri?: string;
    /** Workspace-relative path, for display. */
    readonly path?: string;
    readonly toolCallId?: string;

    // change
    readonly old?: string;
    readonly new?: string;
    /** The change creates the file. */
    readonly create?: boolean;
    state: StopState;
    /** Why a stop is stale, in the reviewer's terms. */
    staleReason?: string;

    // context
    /** Text the stop points at; located again every time the stop is opened. */
    readonly quote?: string;

    // result
    readonly command?: string;
    readonly exitCode?: number | null;
    readonly output?: string;
}

export interface Tour {
    readonly id: string;
    readonly sessionId: string;
    readonly requestId: string;
    /** What the human asked for. */
    title: string;
    /** The agent's closing words, once it has finished. */
    summary?: string;
    running: boolean;
    readonly startedAt: number;
    readonly stops: Stop[];
}

export namespace Tour {
    export function pending(tour: Tour): Stop[] {
        return tour.stops.filter(stop => stop.kind === 'change' && stop.state === 'pending');
    }
    export function changes(tour: Tour): Stop[] {
        return tour.stops.filter(stop => stop.kind === 'change');
    }
}

/** Number of non-overlapping occurrences of `needle` in `text`. */
export function countOccurrences(text: string, needle: string): number {
    if (needle.length === 0) {
        return 0;
    }
    let count = 0;
    let index = text.indexOf(needle);
    while (index !== -1) {
        count++;
        index = text.indexOf(needle, index + needle.length);
    }
    return count;
}

export interface LineSpan {
    /** 1-based, inclusive. */
    startLine: number;
    endLine: number;
}

/** The lines `needle` covers in `text`, or undefined when it does not occur. */
export function locate(text: string, needle: string): LineSpan | undefined {
    const index = needle.length > 0 ? text.indexOf(needle) : -1;
    if (index === -1) {
        return undefined;
    }
    const startLine = lineAt(text, index);
    const trimmed = needle.replace(/\n+$/, '');
    return { startLine, endLine: startLine + (trimmed.match(/\n/g)?.length ?? 0) };
}

export function lineAt(text: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
        }
    }
    return line;
}
