import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { PreferenceScope, PreferenceService, URI } from '@theia/core';
import { codicon, ReactWidget } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';
import { ActivityEntry, ActivityService, ActivityTurn } from './activity-service.js';
import { FOLLOW_PREF, StopPresenter } from './stop-presenter.js';
import { TourService } from './tour-service.js';

export const ACTIVITY_WIDGET_ID = 'cicerone.activity';

const STATUS_ICON: Record<string, string> = {
    'running': 'loading codicon-modifier-spin',
    'awaiting-approval': 'shield',
    'done': 'check',
    'failed': 'error',
    'denied': 'circle-slash'
};

@injectable()
export class ActivityWidget extends ReactWidget {

    static readonly ID = ACTIVITY_WIDGET_ID;
    static readonly LABEL = 'Agent Activity';

    @inject(ActivityService) protected readonly activity: ActivityService;
    @inject(TourService) protected readonly tours: TourService;
    @inject(StopPresenter) protected readonly presenter: StopPresenter;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(PreferenceService) protected readonly preferences: PreferenceService;

    protected ticker: ReturnType<typeof setInterval> | undefined;

    @postConstruct()
    protected init(): void {
        this.id = ACTIVITY_WIDGET_ID;
        this.title.label = ActivityWidget.LABEL;
        this.title.caption = 'What the agent is doing, step by step';
        this.title.iconClass = codicon('pulse');
        this.title.closable = true;
        this.addClass('cicerone-activity');
        this.node.tabIndex = 0;
        this.toDispose.push(this.activity.onDidChange(() => { this.update(); this.tick(); }));
        this.toDispose.push(this.preferences.onPreferenceChanged(event => {
            if (event.preferenceName === FOLLOW_PREF) {
                this.update();
            }
        }));
        this.update();
    }

    /** Elapsed times only need repainting while something is running. */
    protected tick(): void {
        const running = !!this.activity.runningTurn;
        if (running && !this.ticker) {
            this.ticker = setInterval(() => this.update(), 1000);
        } else if (!running && this.ticker) {
            clearInterval(this.ticker);
            this.ticker = undefined;
        }
    }

    protected render(): React.ReactNode {
        const turns = this.activity.getTurns();
        const totals = this.activity.totals();
        const following = this.presenter.following;
        return <div className='cicerone-activity-body'>
            <header className='cicerone-activity-header'>
                <span className='cicerone-dim'>
                    {totals.input + totals.output > 0
                        ? <>Session: <b>{compact(totals.input)}</b> tokens in{totals.cacheRead > 0 && <> ({compact(totals.cacheRead)} from cache)</>} · <b>{compact(totals.output)}</b> out</>
                        : 'Every step the agent takes is listed here as it happens.'}
                </span>
                <span className='cicerone-activity-tools'>
                    <button className={`cicerone-toggle ${following ? 'on' : ''}`} aria-pressed={following}
                        title='Show each file in the editor as the agent reads or changes it'
                        onClick={() => this.preferences.set(FOLLOW_PREF, !following, PreferenceScope.User)}>
                        <span className={codicon(following ? 'eye' : 'eye-closed')} /> {following ? 'Following' : 'Not following'}
                    </button>
                    <button className='cicerone-toggle' title='Clear finished turns' onClick={() => this.activity.clear()}>
                        <span className={codicon('clear-all')} />
                    </button>
                </span>
            </header>
            <div className='cicerone-turns'>
                {[...turns].reverse().map(turn => <TurnView key={turn.requestId} turn={turn} onOpen={entry => this.open(entry)} />)}
            </div>
        </div>;
    }

    protected async open(entry: ActivityEntry): Promise<void> {
        const stop = entry.stopId ? this.tours.findStop(entry.stopId) : undefined;
        if (stop) {
            await this.presenter.present(stop);
        } else if (entry.uri) {
            const start = entry.span ? { line: entry.span.startLine - 1, character: 0 } : undefined;
            await this.editorManager.open(new URI(entry.uri), { mode: 'activate', preview: true, selection: start && { start, end: start } });
        }
    }
}

function TurnView({ turn, onOpen }: { turn: ActivityTurn, onOpen(entry: ActivityEntry): void }): React.ReactElement {
    const [open, setOpen] = React.useState(true);
    const live = turn.status === 'running' || turn.status === 'waiting';
    const elapsed = turn.entries.length > 0 || live
        ? duration((turn.entries.reduce((latest, entry) => Math.max(latest, entry.endedAt ?? 0), 0) || Date.now()) - turn.startedAt)
        : '';
    return <section className={`cicerone-turn ${turn.status}`}>
        <header className='cicerone-turn-header' onClick={() => setOpen(!open)}>
            <span className={codicon(open ? 'chevron-down' : 'chevron-right')} />
            <span className='cicerone-turn-prompt' title={turn.prompt}>{turn.prompt}</span>
            <span className='cicerone-turn-facts'>
                {turn.model && <span title='Model'>{turn.model}</span>}
                {turn.usage && <span title={`Tokens sent to and received from the model in this turn, over ${turn.roundTrips} model ${turn.roundTrips === 1 ? 'call' : 'calls'}`}>
                    {compact(turn.usage.input)} in · {compact(turn.usage.output)} out
                </span>}
                <span>{turn.entries.length} {turn.entries.length === 1 ? 'step' : 'steps'}</span>
                <span className={`cicerone-turn-status ${turn.status}`}>
                    {turn.status === 'running' ? <><span className={`${codicon('loading')} codicon-modifier-spin`} /> {elapsed}</>
                        : turn.status === 'waiting' ? 'needs you'
                            : turn.status === 'done' ? elapsed : turn.status}
                </span>
            </span>
        </header>
        {open && <div className='cicerone-entries' role='list'>
            {turn.entries.map(entry => {
                const clickable = !!entry.uri || !!entry.stopId;
                return <div key={entry.id} role='listitem' className={`cicerone-entry ${entry.status} ${clickable ? 'clickable' : ''}`}
                    onClick={clickable ? () => onOpen(entry) : undefined}>
                    <span className={`cicerone-entry-status ${codicon(STATUS_ICON[entry.status])}`}
                        title={entry.status === 'awaiting-approval' ? 'Waiting for your approval in the chat' : entry.status} />
                    <span className='cicerone-entry-tool'>{entry.tool}</span>
                    <span className='cicerone-entry-target' title={entry.target}>{entry.target}</span>
                    <span className='cicerone-entry-outcome'>
                        {entry.status === 'awaiting-approval' ? 'waiting for your approval' : entry.status === 'denied' ? 'denied' : entry.outcome}
                    </span>
                    <span className='cicerone-entry-time'>{entry.endedAt ? duration(entry.endedAt - entry.startedAt) : ''}</span>
                </div>;
            })}
            {turn.entries.length === 0 && <div className='cicerone-entry cicerone-dim'>
                <span /><span />{live ? 'Thinking…' : 'Answered without using tools.'}
            </div>}
        </div>}
    </section>;
}

export function compact(tokens: number): string {
    return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 10_000 ? `${Math.round(tokens / 1000)}k`
        : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function duration(ms: number): string {
    if (ms < 950) {
        return ms < 50 ? '' : `${Math.round(ms / 10) / 100}s`;
    }
    const seconds = Math.round(ms / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
