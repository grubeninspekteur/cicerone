import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event, generateUuid, URI } from '@theia/core';
import { StorageService } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { countOccurrences, Stop, Tour } from '../common/tour.js';
import { WorkspaceDocuments } from './workspace-documents.js';

export interface TourOrigin {
    sessionId: string;
    requestId: string;
    /** The human's request; becomes the tour's title. */
    prompt: string;
}

export class ProposalError extends Error { }

const MAX_STORED_TOURS = 20;

/** A file as the proposals would leave it, and what each stop does on the way there. */
interface Chain {
    /** Text before the first pending stop is applied; undefined if the file does not exist. */
    current: string | undefined;
    /** Text with every applicable pending stop applied. */
    proposed: string | undefined;
    steps: Map<string, { before: string, after: string }>;
    stale: Map<string, string>;
}

/**
 * Owns the tours: one per request, each an ordered list of stops.
 *
 * A change stop is an exact-match replacement that has not been written yet. Nothing touches a file
 * until the human accepts the stop; until then the proposal lives only here. The proposed state of a
 * file is its current text with all pending stops replayed in order, which is also what the agent
 * reads, so it can build one edit on another while the human has accepted none of them.
 */
@injectable()
export class TourService {

    @inject(WorkspaceDocuments) protected readonly documents: WorkspaceDocuments;
    @inject(FileService) protected readonly fileService: FileService;
    @inject(StorageService) protected readonly storage: StorageService;
    @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService;

    protected readonly tours: Tour[] = [];
    protected saveTimer: ReturnType<typeof setTimeout> | undefined;
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
    protected readonly onDidAddStopEmitter = new Emitter<Stop>();
    /** Fires for every new stop, so views can follow the agent. */
    readonly onDidAddStop: Event<Stop> = this.onDidAddStopEmitter.event;

    protected readonly onDidFinishEmitter = new Emitter<Tour>();
    /** Fires when the agent has finished the request a tour belongs to. */
    readonly onDidFinish: Event<Tour> = this.onDidFinishEmitter.event;

    protected _currentTourId: string | undefined;
    protected _currentStopId: string | undefined;
    /** Bumped on every mutation; part of proposal URIs so editors never show a cached proposal. */
    protected _revision = 0;
    protected refreshing: Promise<void> = Promise.resolve();
    protected readonly reported = new Map<string, string>();

    @postConstruct()
    protected init(): void {
        // A file edited behind a pending stop can make it stale; find out when it happens, not at accept time.
        this.fileService.onDidFilesChange(event => {
            const affected = this.allPending().some(stop => stop.uri && event.contains(new URI(stop.uri)));
            if (affected) {
                this.refresh();
            }
        });
        this.workspaceService.roots.then(() => this.restore());
    }

    /** Tours are kept per workspace, so a pending proposal is still there after the window is reloaded or closed. */
    protected get storageKey(): string | undefined {
        const root = this.documents.root;
        return root && `cicerone.tours:${root.toString()}`;
    }

    protected async restore(): Promise<void> {
        const key = this.storageKey;
        const stored = key ? await this.storage.getData<Tour[]>(key) : undefined;
        if (!Array.isArray(stored) || this.tours.length > 0) {
            return;
        }
        for (const tour of stored) {
            // Whatever was running when the window closed is not running any more.
            this.tours.push({ ...tour, running: false });
            // The agent heard about these decisions, or its conversation is gone; either way they are not news.
            tour.stops.forEach(stop => this.reported.set(stop.id, stop.state));
        }
        this._revision++;
        this.onDidChangeEmitter.fire();
        this.refresh();
    }

    protected save(): void {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            const key = this.storageKey;
            if (key) {
                // Recent tours only: storage is small, and a tour from last month is history, not work in progress.
                this.storage.setData(key, this.tours.slice(-MAX_STORED_TOURS)).catch(() => { /* full or unavailable: tours then last for the session */ });
            }
        }, 400);
    }

    get revision(): number { return this._revision; }

    getTours(): readonly Tour[] { return this.tours; }

    getTour(id: string | undefined): Tour | undefined {
        return this.tours.find(tour => tour.id === id);
    }

    findTourByRequest(requestId: string): Tour | undefined {
        return this.tours.find(tour => tour.requestId === requestId);
    }

    get currentTour(): Tour | undefined {
        return this.getTour(this._currentTourId) ?? this.tours[this.tours.length - 1];
    }

    get currentStop(): Stop | undefined {
        return this.currentTour?.stops.find(stop => stop.id === this._currentStopId);
    }

    findStop(id: string): Stop | undefined {
        for (const tour of this.tours) {
            const stop = tour.stops.find(candidate => candidate.id === id);
            if (stop) {
                return stop;
            }
        }
        return undefined;
    }

    setCurrent(tourId: string | undefined, stopId?: string): void {
        this._currentTourId = tourId;
        this._currentStopId = stopId;
        this.onDidChangeEmitter.fire();
    }

    /** The stop after (or before) the current one; wraps nowhere, so the ends are noticeable. */
    neighbour(delta: 1 | -1): Stop | undefined {
        const tour = this.currentTour;
        if (!tour || tour.stops.length === 0) {
            return undefined;
        }
        const index = tour.stops.findIndex(stop => stop.id === this._currentStopId);
        if (index === -1) {
            return delta === 1 ? tour.stops[0] : tour.stops[tour.stops.length - 1];
        }
        return tour.stops[index + delta];
    }

    pendingCount(): number {
        return this.allPending().length;
    }

    protected allPending(): Stop[] {
        return this.tours.flatMap(tour => Tour.pending(tour));
    }

    protected tourFor(origin: TourOrigin): Tour {
        let tour = this.findTourByRequest(origin.requestId);
        if (!tour) {
            tour = {
                id: generateUuid(),
                sessionId: origin.sessionId,
                requestId: origin.requestId,
                title: summarizePrompt(origin.prompt),
                running: true,
                startedAt: Date.now(),
                stops: []
            };
            this.tours.push(tour);
            // A new tour takes the stage unless the human is in the middle of reviewing another one.
            if (!this.currentStop || Tour.pending(this.currentTour!).length === 0) {
                this._currentTourId = tour.id;
                this._currentStopId = undefined;
            }
        }
        return tour;
    }

    protected addStop(origin: TourOrigin, stop: Omit<Stop, 'id' | 'tourId' | 'n'>): Stop {
        const tour = this.tourFor(origin);
        const created: Stop = { ...stop, id: generateUuid(), tourId: tour.id, n: tour.stops.length + 1 };
        tour.stops.push(created);
        this.changed();
        this.onDidAddStopEmitter.fire(created);
        return created;
    }

    /**
     * Records a replacement as a pending change stop.
     * @throws ProposalError, worded for the model, when `old` does not identify exactly one place.
     */
    async proposeEdit(origin: TourOrigin, uri: URI, oldText: string, newText: string, why: string, toolCallId?: string): Promise<Stop> {
        const path = this.documents.relative(uri);
        const chain = await this.chain(uri);
        let create = false;
        if (oldText === '') {
            if (chain.proposed !== undefined && chain.proposed !== '') {
                throw new ProposalError(`${path} already exists. To change it, pass the text to replace as \`old\`.`);
            }
            create = chain.proposed === undefined;
        } else {
            if (chain.proposed === undefined) {
                throw new ProposalError(`${path} does not exist. To create it, pass an empty \`old\`.`);
            }
            const occurrences = countOccurrences(chain.proposed, oldText);
            if (occurrences === 0) {
                throw new ProposalError(`\`old\` was not found in ${path}. It must match the file exactly, including whitespace; read the file again.`);
            }
            if (occurrences > 1) {
                throw new ProposalError(`\`old\` occurs ${occurrences} times in ${path}. Include more surrounding text so it identifies one place.`);
            }
            if (oldText === newText) {
                throw new ProposalError('`old` and `new` are identical; nothing to change.');
            }
        }
        return this.addStop(origin, { kind: 'change', why, uri: uri.toString(), path, old: oldText, new: newText, create, state: 'pending', toolCallId });
    }

    addContext(origin: TourOrigin, uri: URI, quote: string, why: string, toolCallId?: string): Stop {
        return this.addStop(origin, { kind: 'context', why, uri: uri.toString(), path: this.documents.relative(uri), quote, state: 'accepted', toolCallId });
    }

    addResult(origin: TourOrigin, command: string, exitCode: number | null, output: string, why: string, toolCallId?: string): Stop {
        return this.addStop(origin, { kind: 'result', why, command, exitCode, output, state: 'accepted', toolCallId });
    }

    finish(requestId: string, summary: string | undefined): void {
        const tour = this.findTourByRequest(requestId);
        if (tour) {
            tour.running = false;
            tour.summary = summary?.trim() || tour.summary;
            this.changed();
            this.onDidFinishEmitter.fire(tour);
        }
    }

    /** The file as it would read with every pending stop accepted; undefined when it would not exist. */
    async proposedText(uri: URI): Promise<string | undefined> {
        return (await this.chain(uri)).proposed;
    }

    /** What a change stop does: the text right before and right after it. */
    async sides(stop: Stop): Promise<{ before: string, after: string }> {
        if (stop.kind !== 'change' || !stop.uri) {
            return { before: '', after: '' };
        }
        const uri = new URI(stop.uri);
        if (stop.state === 'pending') {
            const step = (await this.chain(uri)).steps.get(stop.id);
            if (step) {
                return step;
            }
        }
        // Accepted, rejected or stale: show the replacement in isolation, anchored in the current text if it is there.
        const current = await this.documents.read(uri) ?? '';
        if (stop.state === 'accepted' && stop.new && countOccurrences(current, stop.new) >= 1) {
            return { before: current.replace(stop.new, () => stop.old ?? ''), after: current };
        }
        if (stop.old && countOccurrences(current, stop.old) >= 1) {
            return { before: current, after: current.replace(stop.old, () => stop.new ?? '') };
        }
        return { before: stop.old ?? '', after: stop.new ?? '' };
    }

    protected async chain(uri: URI): Promise<Chain> {
        const key = uri.toString();
        const current = await this.documents.read(uri);
        const chain: Chain = { current, proposed: current, steps: new Map(), stale: new Map() };
        for (const stop of this.allPending()) {
            if (stop.uri !== key) {
                continue;
            }
            const text = chain.proposed;
            if (stop.old === '') {
                if (text === undefined || text === '') {
                    chain.steps.set(stop.id, { before: '', after: stop.new ?? '' });
                    chain.proposed = stop.new ?? '';
                } else {
                    chain.stale.set(stop.id, 'The file has been created in the meantime.');
                }
                continue;
            }
            const occurrences = text === undefined ? 0 : countOccurrences(text, stop.old!);
            if (occurrences === 1) {
                const after = text!.replace(stop.old!, () => stop.new ?? '');
                chain.steps.set(stop.id, { before: text!, after });
                chain.proposed = after;
            } else {
                chain.stale.set(stop.id, occurrences === 0
                    ? 'The text this change replaces is no longer in the file.'
                    : 'The text this change replaces is no longer unique in the file.');
            }
        }
        return chain;
    }

    /** Re-evaluates which pending stops still apply. */
    refresh(): Promise<void> {
        this.refreshing = this.refreshing.then(async () => {
            const uris = new Set(this.allPending().map(stop => stop.uri!).filter(Boolean));
            let changed = false;
            for (const uri of uris) {
                const chain = await this.chain(new URI(uri));
                for (const [stopId, reason] of chain.stale) {
                    const stop = this.findStop(stopId);
                    if (stop && stop.state === 'pending') {
                        stop.state = 'stale';
                        stop.staleReason = reason;
                        changed = true;
                    }
                }
            }
            if (changed) {
                this.changed();
            }
        }).catch(() => { /* a failed refresh only delays the stale marker */ });
        return this.refreshing;
    }

    /**
     * Writes a pending change to its file.
     * @returns undefined on success, otherwise why it could not be applied, worded for the human.
     */
    async accept(stop: Stop): Promise<string | undefined> {
        if (stop.kind !== 'change' || stop.state !== 'pending' || !stop.uri) {
            return undefined;
        }
        const uri = new URI(stop.uri);
        const current = await this.documents.read(uri);
        if (stop.old === '') {
            if (current !== undefined && current !== '') {
                return this.markStale(stop, 'The file has been created in the meantime.');
            }
            if (current === undefined) {
                await this.documents.create(uri, stop.new ?? '');
            } else {
                await this.documents.replace(uri, 0, 0, stop.new ?? '');
            }
        } else {
            const occurrences = current === undefined ? 0 : countOccurrences(current, stop.old!);
            if (occurrences !== 1) {
                const earlier = this.allPending().find(other => other.uri === stop.uri && other !== stop
                    && (other.tourId !== stop.tourId || other.n < stop.n));
                if (earlier && (await this.chain(uri)).steps.has(stop.id)) {
                    return `Stop ${stop.n} builds on stop ${earlier.n}, which is still pending. Accept that one first.`;
                }
                return this.markStale(stop, occurrences === 0
                    ? 'The text this change replaces is no longer in the file.'
                    : 'The text this change replaces is no longer unique in the file.');
            }
            await this.documents.replace(uri, current!.indexOf(stop.old!), stop.old!.length, stop.new ?? '');
        }
        stop.state = 'accepted';
        this.changed();
        await this.refresh();
        return undefined;
    }

    protected markStale(stop: Stop, reason: string): string {
        stop.state = 'stale';
        stop.staleReason = reason;
        this.changed();
        return reason;
    }

    async reject(stop: Stop): Promise<void> {
        if (stop.kind === 'change' && (stop.state === 'pending' || stop.state === 'stale')) {
            stop.state = 'rejected';
            this.changed();
            // Later stops written on top of this one have lost their footing.
            await this.refresh();
        }
    }

    /** Takes an accepted change back out of the file and makes it pending again. */
    async undo(stop: Stop): Promise<string | undefined> {
        if (stop.kind !== 'change' || stop.state !== 'accepted' || !stop.uri) {
            return undefined;
        }
        const uri = new URI(stop.uri);
        const current = await this.documents.read(uri);
        if (stop.create) {
            if (current !== stop.new) {
                return 'The file has changed since it was created; delete it by hand if you no longer want it.';
            }
            await this.documents.delete(uri);
        } else {
            if (current === undefined || countOccurrences(current, stop.new ?? '') !== 1) {
                return 'The accepted text has been edited since; undo it in the editor instead.';
            }
            await this.documents.replace(uri, current.indexOf(stop.new!), stop.new!.length, stop.old ?? '');
        }
        stop.state = 'pending';
        this.changed();
        return undefined;
    }

    /** Accepts every pending change of the tour in order; stops at the first that cannot be applied. */
    async acceptAll(tour: Tour): Promise<string | undefined> {
        for (const stop of [...tour.stops]) {
            if (stop.kind === 'change' && stop.state === 'pending') {
                const problem = await this.accept(stop);
                if (problem) {
                    return `Stop ${stop.n}: ${problem}`;
                }
            }
        }
        return undefined;
    }

    async rejectAll(tour: Tour): Promise<void> {
        for (const stop of Tour.pending(tour)) {
            stop.state = 'rejected';
        }
        this.changed();
    }

    /**
     * What the human decided since the agent last heard: one line for the next request, so the agent
     * does not assume a rejected change went in. Each decision is reported once.
     */
    reviewNote(sessionId: string): string | undefined {
        const accepted: number[] = [];
        const rejected: number[] = [];
        const stale: number[] = [];
        for (const tour of this.tours) {
            if (tour.sessionId !== sessionId) {
                continue;
            }
            for (const stop of Tour.changes(tour)) {
                const reported = this.reported.get(stop.id) ?? 'pending';
                if (reported !== stop.state) {
                    this.reported.set(stop.id, stop.state);
                    (stop.state === 'accepted' ? accepted : stop.state === 'rejected' ? rejected : stop.state === 'stale' ? stale : []).push(stop.n);
                }
            }
        }
        const parts = [
            accepted.length ? `accepted ${accepted.join(', ')}` : '',
            rejected.length ? `rejected ${rejected.join(', ')}` : '',
            stale.length ? `no longer applicable ${stale.join(', ')}` : ''
        ].filter(Boolean);
        return parts.length ? `[review of your stops: ${parts.join('; ')}]` : undefined;
    }

    removeTour(tour: Tour): void {
        const index = this.tours.indexOf(tour);
        if (index !== -1) {
            this.tours.splice(index, 1);
            if (this._currentTourId === tour.id) {
                this._currentTourId = undefined;
                this._currentStopId = undefined;
            }
            this.changed();
        }
    }

    protected changed(): void {
        this._revision++;
        this.onDidChangeEmitter.fire();
        this.save();
    }
}

export function summarizePrompt(prompt: string): string {
    const line = prompt.replace(/^@\S+\s*/, '').trim().split('\n')[0] ?? '';
    return line.length > 80 ? line.slice(0, 77).trimEnd() + '…' : line || 'Untitled';
}
