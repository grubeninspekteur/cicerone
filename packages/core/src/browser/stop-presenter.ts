import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { PreferenceService, Resource, ResourceResolver, URI } from '@theia/core';
import { DiffUris, open, OpenerService } from '@theia/core/lib/browser';
import { EditorManager, EditorWidget, TextEditor } from '@theia/editor/lib/browser';
import { globToRegExp } from '../common/glob.js';
import { LineSpan, locate, Stop } from '../common/tour.js';
import { TourService } from './tour-service.js';
import { WorkspaceDocuments } from './workspace-documents.js';

export const CICERONE_SCHEME = 'cicerone';
export const FOLLOW_PREF = 'cicerone.followAgent';
export const REVIEW_PREF = 'cicerone.review';
export const WRITE_AT_ONCE_PREF = 'cicerone.review.writeAtOnce';
/** `before`: changes wait for the human. `after`: changes are written as they are made and reviewed afterwards. */
export type ReviewMode = 'before' | 'after';

type Side = 'before' | 'after' | 'output';

/** Serves the two sides of a change stop, and command output, as read-only documents. */
@injectable()
export class ProposalResourceResolver implements ResourceResolver {

    @inject(TourService) protected readonly tours: TourService;

    resolve(uri: URI): Resource {
        if (uri.scheme !== CICERONE_SCHEME) {
            throw new Error(`Not a ${CICERONE_SCHEME} resource: ${uri}`);
        }
        const [, side, stopId] = uri.path.toString().split('/');
        return {
            uri,
            readOnly: true,
            readContents: async () => {
                const stop = this.tours.findStop(stopId);
                if (!stop) {
                    return '';
                }
                if (side === 'output') {
                    return `$ ${stop.command}\n${stop.output ?? ''}\n[exit ${stop.exitCode ?? 'unknown'}]\n`;
                }
                return (await this.tours.sides(stop))[side as 'before' | 'after'];
            },
            dispose: () => { /* nothing held */ }
        };
    }
}

/**
 * Puts a stop in front of the human: the file, at the place, with the change visible.
 * Also follows the agent around while it works, if the human wants that.
 */
@injectable()
export class StopPresenter {

    @inject(TourService) protected readonly tours: TourService;
    @inject(WorkspaceDocuments) protected readonly documents: WorkspaceDocuments;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(OpenerService) protected readonly openerService: OpenerService;
    @inject(PreferenceService) protected readonly preferences: PreferenceService;

    /** The highlight of the stop being looked at; replaced whenever another stop is presented. */
    protected spotlight: { editor: TextEditor, ids: string[] } | undefined;

    /** True while the stop on screen was put there by following the agent, not chosen by the human. */
    protected followed = false;
    protected nextToFollow: Stop | undefined;

    @postConstruct()
    protected init(): void {
        this.tours.onDidAddStop(stop => {
            // While the agent works, each new stop is shown as it appears, unless the human is busy reviewing.
            // Stops often arrive in bursts; only the last of a burst is worth opening an editor for.
            if (this.following && !this.reviewing) {
                const idle = !this.nextToFollow;
                this.nextToFollow = stop;
                if (idle) {
                    setTimeout(() => {
                        const latest = this.nextToFollow;
                        this.nextToFollow = undefined;
                        if (latest && !this.reviewing) {
                            this.present(latest, false);
                        }
                    }, 250);
                }
            }
        });
        this.tours.onDidFinish(tour => {
            // The agent is done: hand over at the beginning of the tour, unless the human already went somewhere.
            this.nextToFollow = undefined;
            if (this.following && tour === this.tours.currentTour && tour.stops.length > 0 && (this.followed || !this.tours.currentStop)) {
                this.present(tour.stops[0], false);
            }
        });
    }

    get following(): boolean {
        return this.preferences.get<boolean>(FOLLOW_PREF, true);
    }

    /**
     * Both review settings are read from the user's own settings only. A setting in the workspace is a
     * file the agent can edit, and the agent must not be able to widen its own leash.
     */
    get reviewMode(): ReviewMode {
        return this.preferences.inspect<ReviewMode>(REVIEW_PREF)?.globalValue === 'after' ? 'after' : 'before';
    }

    /**
     * Whether a change to this file is written at once. Decided by rules the human set (the review
     * mode, and paths they declared low-stakes), never by how sure the model says it is.
     */
    writesAtOnce(path: string): boolean {
        if (this.reviewMode === 'after') {
            return true;
        }
        const globs = this.preferences.inspect<string[]>(WRITE_AT_ONCE_PREF)?.globalValue;
        return Array.isArray(globs) && globs.some(glob => {
            try {
                return typeof glob === 'string' && globToRegExp(glob).test(path);
            } catch {
                return false;
            }
        });
    }

    /** True once the human has picked a stop, or the agent has finished and handed the tour over. */
    protected get reviewing(): boolean {
        const current = this.tours.currentStop;
        return !!current && (!this.followed || !this.tours.currentTour?.running);
    }

    protected proposalUri(side: Side, stop: Stop, name: string): URI {
        return new URI().withScheme(CICERONE_SCHEME).withPath(`/${side}/${stop.id}/${this.tours.revision}/${name}`);
    }

    async present(stop: Stop, activate = true): Promise<void> {
        this.followed = !activate;
        this.tours.setCurrent(stop.tourId, stop.id);
        const mode = activate ? 'activate' : 'reveal';
        if (stop.kind === 'result') {
            await open(this.openerService, this.proposalUri('output', stop, `stop-${stop.n}.log`), { mode, preview: true });
            return;
        }
        if (!stop.uri) {
            return;
        }
        const uri = new URI(stop.uri);
        const name = uri.path.base;
        if (stop.kind === 'change') {
            const { after } = await this.tours.sides(stop);
            const span = stop.new ? locate(after, stop.new) : stop.old ? undefined : { startLine: 1, endLine: 1 };
            // An applied change is compared against the real file, which stays editable on the right.
            const applied = stop.state === 'accepted' && await this.documents.read(uri) !== undefined;
            const right = applied ? uri : this.proposalUri('after', stop, name);
            const diff = DiffUris.encode(this.proposalUri('before', stop, name), right, `Stop ${stop.n} · ${name}`);
            await open(this.openerService, diff, { mode, preview: true, selection: span && toSelection(span, true) });
            return;
        }
        const text = await this.documents.read(uri);
        const needle = stop.quote;
        const span = text !== undefined && needle ? locate(text, needle) ?? locate(text, needle.trim()) : undefined;
        await this.reveal(uri, span, mode, true);
    }

    /** Shows where the agent is reading right now. Does nothing unless following is on and no review is in progress. */
    async follow(uri: URI, span?: LineSpan): Promise<void> {
        if (!this.following || this.reviewing) {
            return;
        }
        try {
            await this.reveal(uri, span, 'reveal', false);
        } catch {
            // Following is a courtesy; a file that cannot be shown must not disturb the agent.
        }
    }

    protected async reveal(uri: URI, span: LineSpan | undefined, mode: 'activate' | 'reveal', keep: boolean): Promise<void> {
        const widget: EditorWidget = await this.editorManager.open(uri, {
            mode, preview: true, selection: span && toSelection(span, true), revealOption: 'centerIfOutsideViewport'
        });
        this.clearSpotlight();
        if (!span) {
            return;
        }
        const editor = widget.editor;
        const ids = editor.deltaDecorations({
            oldDecorations: [],
            newDecorations: [{
                range: toSelection(span, false),
                options: { isWholeLine: true, className: keep ? 'cicerone-spotlight' : 'cicerone-reading', linesDecorationsClassName: 'cicerone-spotlight-gutter' }
            }]
        });
        this.spotlight = { editor, ids };
        if (!keep) {
            const mine = this.spotlight;
            setTimeout(() => {
                if (this.spotlight === mine) {
                    this.clearSpotlight();
                }
            }, 2500);
        }
    }

    protected clearSpotlight(): void {
        if (this.spotlight) {
            try {
                this.spotlight.editor.deltaDecorations({ oldDecorations: this.spotlight.ids, newDecorations: [] });
            } catch {
                // the editor is gone, and its decorations with it
            }
            this.spotlight = undefined;
        }
    }
}

function toSelection(span: LineSpan, collapsed: boolean): { start: { line: number, character: number }, end: { line: number, character: number } } {
    const start = { line: span.startLine - 1, character: 0 };
    return { start, end: collapsed ? start : { line: span.endLine - 1, character: 0 } };
}
