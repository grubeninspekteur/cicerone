import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandService, MessageService, PreferenceScope, PreferenceService } from '@theia/core';
import { codicon, ReactWidget } from '@theia/core/lib/browser';
import { Stop, Tour } from '../common/tour.js';
import { Markdown } from './markdown.js';
import { REVIEW_PREF, StopPresenter } from './stop-presenter.js';
import { TourService } from './tour-service.js';

export const TOUR_WIDGET_ID = 'cicerone.tour';

export namespace TourCommandIds {
    export const DISCUSS = 'cicerone.tour.discuss';
}

@injectable()
export class TourWidget extends ReactWidget {

    static readonly ID = TOUR_WIDGET_ID;
    static readonly LABEL = 'Tour';

    @inject(TourService) protected readonly tours: TourService;
    @inject(StopPresenter) protected readonly presenter: StopPresenter;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(CommandService) protected readonly commands: CommandService;
    @inject(PreferenceService) protected readonly preferences: PreferenceService;

    @postConstruct()
    protected init(): void {
        this.id = TOUR_WIDGET_ID;
        this.title.label = TourWidget.LABEL;
        this.title.caption = 'Tour: the agent shows its work';
        this.title.iconClass = codicon('compass');
        this.title.closable = true;
        this.addClass('cicerone-tour');
        this.node.tabIndex = 0;
        this.toDispose.push(this.tours.onDidChange(() => this.update()));
        this.toDispose.push(this.preferences.onPreferenceChanged(event => {
            if (event.preferenceName === REVIEW_PREF) {
                this.update();
            }
        }));
        this.update();
    }

    protected override onAfterShow(): void {
        this.tours.refresh();
    }

    /** The one dial of trust: do changes wait for the human, or does the human check them afterwards? */
    protected renderReviewToggle(): React.ReactNode {
        const before = this.presenter.reviewMode === 'before';
        return <button className={`cicerone-toggle ${before ? 'on' : ''}`} aria-pressed={before}
            title={before
                ? 'Changes wait for you: nothing is written until you accept a stop. Click to let the agent write changes at once and review them afterwards.'
                : 'Changes are written as the agent makes them; you review afterwards and can undo any stop. Click to make changes wait for you.'}
            onClick={() => this.preferences.set(REVIEW_PREF, before ? 'after' : 'before', PreferenceScope.User)}>
            <span className={codicon(before ? 'shield' : 'zap')} /> {before ? 'Changes wait for you' : 'Written, then reviewed'}
        </button>;
    }

    protected render(): React.ReactNode {
        const tours = this.tours.getTours();
        const tour = this.tours.currentTour;
        if (!tour) {
            return <div className='cicerone-empty'>
                <div className={`cicerone-empty-icon ${codicon('compass')}`} />
                <h3>No tour yet</h3>
                <p>Ask for something in the chat. Every change the agent makes, and every place it wants you to see, shows up here as a stop you can step through.</p>
                <p>{this.renderReviewToggle()}</p>
            </div>;
        }
        const current = this.tours.currentStop;
        const pending = Tour.pending(tour).length;
        const changes = Tour.changes(tour).length;
        const applied = Tour.changes(tour).filter(stop => stop.state === 'accepted').length;
        const index = current ? tour.stops.indexOf(current) : -1;
        return <div className='cicerone-tour-body'>
            <header className='cicerone-tour-header'>
                {tours.length > 1 && <select className='theia-select cicerone-tour-select' value={tour.id}
                    onChange={event => this.tours.setCurrent(event.target.value)} title='Earlier tours'>
                    {tours.map((candidate, i) => <option key={candidate.id} value={candidate.id}>{`${i + 1}. ${candidate.title}`}</option>)}
                </select>}
                <h2 className='cicerone-tour-title' title={tour.title}>{tour.title}</h2>
                <div className='cicerone-tour-meta'>
                    {tour.running
                        ? <span className='cicerone-chip working'><span className={`${codicon('loading')} codicon-modifier-spin`} /> working</span>
                        : pending > 0
                            ? <span className='cicerone-chip pending'>{pending} of {changes} to review</span>
                            : <span className='cicerone-chip done'>{changes === 0 ? 'no changes' : `${applied} of ${changes} applied`}</span>}
                    <span className='cicerone-dim'>{tour.stops.length} {tour.stops.length === 1 ? 'stop' : 'stops'}</span>
                    <span className='cicerone-spacer' />
                    {this.renderReviewToggle()}
                </div>
                <div className='cicerone-track' role='tablist' aria-label='Stops'>
                    {tour.stops.map(stop => <button key={stop.id} role='tab' aria-selected={stop === current}
                        className={`cicerone-track-seg ${stop.kind} ${stop.state} ${stop === current ? 'current' : ''}`}
                        title={`Stop ${stop.n}: ${stop.why}`} onClick={() => this.presenter.present(stop)} />)}
                </div>
            </header>
            {tour.summary && <Markdown block className='cicerone-summary' text={tour.summary} />}
            <ol className='cicerone-stops'>
                {tour.stops.map(stop => <StopRow key={stop.id} stop={stop} current={stop === current}
                    onOpen={() => this.presenter.present(stop)}
                    onAccept={() => this.accept(stop)}
                    onReject={() => this.tours.reject(stop)}
                    onUndo={() => this.undo(stop)}
                    onDiscuss={() => this.commands.executeCommand(TourCommandIds.DISCUSS, stop.id)} />)}
                {tour.stops.length === 0 && <li className='cicerone-dim cicerone-waiting'>The agent is reading. Stops appear as it proposes them.</li>}
            </ol>
            <footer className='cicerone-tour-footer'>
                <button className='theia-button secondary' disabled={index <= 0} onClick={() => this.step(-1)} title='Previous stop (Alt+K)'>
                    <span className={codicon('arrow-left')} /> Previous
                </button>
                <span className='cicerone-dim'>{index >= 0 ? `${index + 1} / ${tour.stops.length}` : `${tour.stops.length} stops`}</span>
                <button className='theia-button' disabled={tour.stops.length === 0 || index === tour.stops.length - 1} onClick={() => this.step(1)}
                    title='Next stop (Alt+J)'>
                    {index === -1 ? 'Start' : 'Next'} <span className={codicon('arrow-right')} />
                </button>
            </footer>
            {pending > 1 && <div className='cicerone-bulk'>
                <button className='theia-button secondary' onClick={() => this.acceptAll(tour)}>Accept all {pending}</button>
                <button className='theia-button secondary' onClick={() => this.tours.rejectAll(tour)}>Reject all</button>
            </div>}
        </div>;
    }

    step(delta: 1 | -1): void {
        const stop = this.tours.neighbour(delta);
        if (stop) {
            this.presenter.present(stop);
        }
    }

    async accept(stop: Stop): Promise<void> {
        const problem = await this.tours.accept(stop);
        if (problem) {
            this.messages.warn(problem);
            return;
        }
        // Accepting is the common case when stepping through: move on to the next undecided change.
        const tour = this.tours.getTour(stop.tourId);
        const next = tour?.stops.find(candidate => candidate.n > stop.n && candidate.kind === 'change' && candidate.state === 'pending');
        await this.presenter.present(next ?? stop);
    }

    async undo(stop: Stop): Promise<void> {
        const problem = await this.tours.undo(stop);
        if (problem) {
            this.messages.warn(problem);
        }
    }

    async acceptAll(tour: Tour): Promise<void> {
        const problem = await this.tours.acceptAll(tour);
        if (problem) {
            this.messages.warn(problem);
        }
    }
}

interface StopRowProps {
    stop: Stop;
    current: boolean;
    onOpen(): void;
    onAccept(): void;
    onReject(): void;
    onUndo(): void;
    onDiscuss(): void;
}

const KIND_ICON: Record<string, string> = { change: 'edit', context: 'eye', result: 'terminal' };
const STATE_LABEL: Record<string, string> = { pending: 'pending', accepted: 'applied', rejected: 'rejected', stale: 'stale' };

function StopRow(props: StopRowProps): React.ReactElement {
    const { stop, current } = props;
    const ref = React.useRef<HTMLLIElement>(null);
    React.useEffect(() => {
        if (current) {
            ref.current?.scrollIntoView({ block: 'nearest' });
        }
    }, [current]);
    const isChange = stop.kind === 'change';
    const icon = stop.create ? 'new-file' : KIND_ICON[stop.kind];
    const directory = stop.path?.includes('/') ? stop.path.slice(0, stop.path.lastIndexOf('/') + 1) : '';
    const base = stop.path ? stop.path.slice(directory.length) : stop.command ?? '';
    const stopClick = (handler: () => void) => (event: React.MouseEvent) => { event.stopPropagation(); handler(); };
    return <li ref={ref} className={`cicerone-stop ${stop.kind} ${stop.state} ${current ? 'current' : ''}`} onClick={props.onOpen}
        aria-current={current ? 'step' : undefined}>
        <span className='cicerone-stop-n'>{stop.n}</span>
        <div className='cicerone-stop-main'>
            <div className='cicerone-stop-head'>
                <span className={`cicerone-stop-icon ${codicon(icon)}`} />
                <span className='cicerone-stop-target' title={stop.path ?? stop.command}>
                    {stop.kind === 'result' ? <code>{base}</code> : <><span className='cicerone-dim'>{directory}</span>{base}</>}
                </span>
                {isChange && <span className={`cicerone-state ${stop.state}`}>{STATE_LABEL[stop.state]}</span>}
                {stop.kind === 'result' && <span className={`cicerone-state ${stop.exitCode === 0 ? 'accepted' : 'stale'}`}>exit {stop.exitCode ?? '?'}</span>}
            </div>
            {stop.why && <Markdown className={`cicerone-stop-why ${current ? '' : 'clamped'}`} text={stop.why} />}
            {current && stop.state === 'stale' && stop.staleReason && <div className='cicerone-stale-reason'>
                <span className={codicon('warning')} /> {stop.staleReason}
            </div>}
            {current && isChange && <ChangePreview stop={stop} />}
            {current && stop.kind === 'result' && stop.output && <pre className='cicerone-output'>{tail(stop.output, 8)}</pre>}
            {current && <div className='cicerone-stop-actions'>
                {isChange && stop.state === 'pending' && <>
                    <button className='theia-button' onClick={stopClick(props.onAccept)} title='Write this change to the file (Alt+Enter)'>
                        <span className={codicon('check')} /> Accept
                    </button>
                    <button className='theia-button secondary' onClick={stopClick(props.onReject)} title='Drop this change (Alt+Backspace)'>
                        <span className={codicon('close')} /> Reject
                    </button>
                </>}
                {isChange && stop.state === 'accepted' && <button className='theia-button secondary' onClick={stopClick(props.onUndo)}
                    title='Take this change back out of the file'>
                    <span className={codicon('discard')} /> Undo
                </button>}
                {isChange && stop.state === 'stale' && <button className='theia-button secondary' onClick={stopClick(props.onReject)}>Dismiss</button>}
                <button className='theia-button secondary' onClick={stopClick(props.onDiscuss)} title='Ask the agent about this stop'>
                    <span className={codicon('comment')} /> Discuss
                </button>
            </div>}
        </div>
    </li>;
}

/**
 * The change in miniature: what goes, what comes, with the part that actually differs emphasised.
 * For prose this is usually a few words inside a paragraph, which a line diff alone shows badly.
 */
function ChangePreview({ stop }: { stop: Stop }): React.ReactElement | null {
    const oldText = stop.old ?? '';
    const newText = stop.new ?? '';
    if (!oldText && !newText) {
        return null;
    }
    let prefix = 0;
    const max = Math.min(oldText.length, newText.length);
    while (prefix < max && oldText[prefix] === newText[prefix]) { prefix++; }
    let suffix = 0;
    while (suffix < max - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) { suffix++; }
    // Widen to word boundaries so half-words are not highlighted.
    while (prefix > 0 && /\w/.test(oldText[prefix - 1])) { prefix--; }
    while (suffix > 0 && /\w/.test(oldText[oldText.length - suffix])) { suffix--; }
    const part = (text: string, sign: '-' | '+') => {
        if (!text) {
            return null;
        }
        const head = clipStart(text.slice(0, prefix), 80);
        const body = clipMiddle(text.slice(prefix, text.length - suffix), 600);
        const foot = clipEnd(text.slice(text.length - suffix), 80);
        return <div className={`cicerone-preview-side ${sign === '-' ? 'removed' : 'added'}`}>
            <span className='cicerone-preview-sign'>{sign === '-' ? '−' : '+'}</span>
            <span className='cicerone-preview-text'>{head}<mark>{body}</mark>{foot}</span>
        </div>;
    };
    return <div className='cicerone-preview'>
        {part(oldText, '-')}
        {part(newText, '+')}
    </div>;
}

function clipStart(text: string, max: number): string {
    return text.length > max ? '…' + text.slice(text.length - max) : text;
}

function clipEnd(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + '…' : text;
}

function clipMiddle(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max / 2)} … ${text.slice(text.length - max / 2)}` : text;
}

function tail(text: string, lines: number): string {
    const all = text.split('\n');
    return all.length > lines ? `…\n${all.slice(-lines).join('\n')}` : text;
}
