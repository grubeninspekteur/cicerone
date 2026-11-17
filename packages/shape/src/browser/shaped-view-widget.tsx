import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core';
import { codicon, Message, ReactWidget } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { Markdown } from '@cicerone/core/lib/browser';
import { CHANNEL, ViewEvent, ViewReport, ViewRequest, viewDocument, wardenDocument } from '../common/custom-view.js';
import { actionCommandId, ViewSpec } from '../common/workbench.js';
import { CustomViewHost } from './custom-view-host.js';
import { ViewData, ViewDataService, ViewGroup, ViewItem } from './view-data.js';
import { WorkbenchService } from './workbench-service.js';

export const SHAPED_VIEW_FACTORY = 'cicerone.view';
export const ShapedViewOptions = Symbol('ShapedViewOptions');
export interface ShapedViewOptions { viewId: string }

export const shapedViewWidgetId = (viewId: string) => `${SHAPED_VIEW_FACTORY}:${viewId}`;
export { actionCommandId };
/** Contributed by the workbench applier: sends the agent a request in a fresh conversation. Arguments: text, display text. */
export const ASK_AGENT_COMMAND_ID = 'cicerone.workbench.ask';

/** A view that exists because the workbench description says so. One class renders every kind. */
@injectable()
export class ShapedViewWidget extends ReactWidget {

    @inject(ShapedViewOptions) protected readonly options: ShapedViewOptions;
    @inject(WorkbenchService) protected readonly workbench: WorkbenchService;
    @inject(ViewDataService) protected readonly dataService: ViewDataService;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(FileService) protected readonly fileService: FileService;
    @inject(CommandService) protected readonly commands: CommandService;
    @inject(CustomViewHost) protected readonly host: CustomViewHost;

    protected data: ViewData | undefined;
    protected loading = false;
    protected stale = true;
    protected refreshTimer: ReturnType<typeof setTimeout> | undefined;
    /** Bumped on every reload, so a custom view hears that files may have changed. */
    protected revision = 0;

    @postConstruct()
    protected init(): void {
        this.id = shapedViewWidgetId(this.options.viewId);
        this.title.closable = true;
        this.addClass('cicerone-view');
        this.node.tabIndex = 0;
        this.applySpec();
        this.toDispose.push(this.workbench.onDidChange(() => { this.applySpec(); this.scheduleRefresh(0); }));
        // Any file may feed any view; reloading a visible view is cheap, and hidden ones wait until shown.
        this.toDispose.push(this.fileService.onDidFilesChange(() => this.scheduleRefresh(500)));
    }

    get spec(): ViewSpec | undefined {
        return this.workbench.config.views.find(view => view.id === this.options.viewId);
    }

    protected applySpec(): void {
        const spec = this.spec;
        this.title.label = spec?.title ?? this.options.viewId;
        this.title.caption = spec?.title ?? this.options.viewId;
        this.title.iconClass = codicon(spec?.icon ?? 'list-unordered');
        this.update();
    }

    protected scheduleRefresh(delay: number): void {
        this.stale = true;
        if (!this.isVisible) {
            return;
        }
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), delay);
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        if (this.stale) {
            this.refresh();
        }
    }

    protected override onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        if (this.isVisible && this.stale) {
            this.refresh();
        }
    }

    async refresh(): Promise<void> {
        const spec = this.spec;
        if (!spec || this.loading) {
            return;
        }
        this.loading = true;
        this.stale = false;
        try {
            this.data = await this.dataService.load(spec);
            this.revision++;
        } finally {
            this.loading = false;
            this.update();
            if (this.stale && this.isVisible) {
                this.scheduleRefresh(300);
            }
        }
    }

    protected open(path: string, line?: number): void {
        const root = this.workbench.root;
        if (root) {
            const start = { line: Math.max(0, (line ?? 1) - 1), character: 0 };
            this.editorManager.open(root.resolve(path), { mode: 'activate', selection: line ? { start, end: start } : undefined });
        }
    }

    protected render(): React.ReactNode {
        const spec = this.spec;
        if (!spec) {
            return <div className='cicerone-view-message'>This view is no longer part of the workbench. You can close it.</div>;
        }
        const data = this.data;
        const action = spec.action ? this.workbench.config.actions.find(candidate => candidate.id === spec.action) : undefined;
        return <div className={`cicerone-view-body ${data?.kind === 'custom' ? 'custom' : ''}`}>
            {action && <div className='cicerone-view-bar'>
                <button className='theia-button secondary' onClick={() => this.commands.executeCommand(actionCommandId(action.id))}>
                    <span className={codicon('sparkle')} /> {action.label}
                </button>
            </div>}
            {!data ? <div className='cicerone-view-message'>Loading…</div> : this.renderData(data)}
        </div>;
    }

    protected renderData(data: ViewData): React.ReactNode {
        switch (data.kind) {
            case 'message':
                return <div className='cicerone-view-message'>{data.text}</div>;
            case 'custom':
                return <CustomView key={data.hash} spec={this.spec!} path={data.path} html={data.html} hash={data.hash} revision={this.revision}
                    host={this.host} onOpenCode={() => this.open(data.path)}
                    onAskAgent={error => this.commands.executeCommand(ASK_AGENT_COMMAND_ID,
                        `The custom view "${this.spec?.title}" (${data.path}) fails in its sandbox with this error:\n\n\`\`\`\n${error.slice(0, 1500)}\n\`\`\`\n\n` +
                        'Fix the view\'s code. Load the `workbench` skill first if you need the view API.',
                        `Fix the view "${this.spec?.title}"`)} />;
            case 'document':
                return <div className='cicerone-view-document'>
                    <Markdown block text={data.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')} />
                    <button className='cicerone-view-link' onClick={() => this.open(data.path)}>
                        <span className={codicon('go-to-file')} /> Open {data.path}
                    </button>
                </div>;
            case 'cards':
                return data.cards.length === 0 ? this.renderNothing() : <ul className='cicerone-view-cards'>
                    {data.cards.map(card => <li key={card.path} onClick={() => this.open(card.path)} title={card.path}>
                        <div className='cicerone-view-card-title'>{card.title}</div>
                        {card.fields.length > 0 && <dl>
                            {card.fields.map(([name, value]) => <React.Fragment key={name}><dt>{name}</dt><dd>{value}</dd></React.Fragment>)}
                        </dl>}
                    </li>)}
                </ul>;
            case 'counts': {
                const largest = Math.max(1, ...data.rows.map(row => row.count));
                const progress = data.target ? Math.min(1, data.total / data.target) : undefined;
                return data.rows.length === 0 ? this.renderNothing() : <div className='cicerone-view-counts'>
                    <div className='cicerone-view-total'>
                        <span className='cicerone-view-total-number'>{data.total.toLocaleString()}</span> {data.unit}
                        {data.target !== undefined && <span className='cicerone-dim'> of {data.target.toLocaleString()} · {Math.round(progress! * 100)}%</span>}
                    </div>
                    {progress !== undefined && <div className='cicerone-view-progress'><div style={{ width: `${progress * 100}%` }} /></div>}
                    <table>
                        <tbody>
                            {data.rows.map(row => <tr key={row.path} onClick={() => this.open(row.path)} title={row.path}>
                                <td className='cicerone-view-count-label'>{row.label}</td>
                                <td className='cicerone-view-count-bar'><div style={{ width: `${Math.max(2, row.count / largest * 100)}%` }} /></td>
                                <td className='cicerone-view-count-number'>{row.count.toLocaleString()}</td>
                            </tr>)}
                        </tbody>
                    </table>
                </div>;
            }
            case 'groups':
                if (data.total === 0) {
                    return this.renderNothing();
                }
                return <div className='cicerone-view-groups'>
                    {data.groups.map((group, index) => <GroupView key={group.path ?? group.label ?? index} group={group} flat={data.flat}
                        showCount={this.spec?.kind === 'matches'} onOpen={(path, line) => this.open(path, line)} />)}
                    {data.truncated && <div className='cicerone-view-message'>Showing the first matches of {data.total.toLocaleString()}. Narrow the pattern or the files.</div>}
                </div>;
        }
    }

    protected renderNothing(): React.ReactNode {
        return <div className='cicerone-view-message'>Nothing matches yet{this.spec?.files ? <> in <code>{this.spec.files}</code></> : ''}.</div>;
    }
}

function GroupView(props: { group: ViewGroup, flat: boolean, showCount: boolean, onOpen(path: string, line?: number): void }): React.ReactElement {
    const { group, flat } = props;
    const [open, setOpen] = React.useState(true);
    const items = (open || flat) && <ul>
        {group.items.map((item: ViewItem, index) => <li key={`${item.path}:${item.line}:${index}`} style={{ paddingLeft: 26 + (item.level ?? 0) * 14 }}
            onClick={() => props.onOpen(item.path, item.line)} title={item.detail ?? `${item.path}:${item.line}`}>
            <span className='cicerone-view-item-label'>{item.label}</span>
            {item.detail && <span className='cicerone-view-item-detail'>{item.detail}</span>}
        </li>)}
    </ul>;
    if (flat) {
        return <section className='cicerone-view-group flat'>{items}</section>;
    }
    return <section className='cicerone-view-group'>
        <header onClick={() => group.items.length === 0 && group.path ? props.onOpen(group.path) : setOpen(!open)}>
            <span className={codicon(group.items.length === 0 ? 'dash' : open ? 'chevron-down' : 'chevron-right')} />
            <span className='cicerone-view-group-label' onClick={group.path ? event => { event.stopPropagation(); props.onOpen(group.path!); } : undefined}
                title={group.path}>{group.label}</span>
            {props.showCount && <span className='cicerone-view-group-count'>{group.items.length}</span>}
        </header>
        {items}
    </section>;
}

interface CustomViewProps {
    spec: ViewSpec;
    path: string;
    html: string;
    hash: string;
    revision: number;
    host: CustomViewHost;
    onOpenCode(): void;
    onAskAgent(error: string): void;
}

/**
 * A view whose code the agent wrote. It runs only once the human has allowed this exact code, in two
 * nested sandboxed frames without network (see custom-view.ts), and talks to the workbench through
 * {@link CustomViewHost} alone.
 */
function CustomView(props: CustomViewProps): React.ReactElement {
    const { spec, host, hash } = props;
    const [approved, setApproved] = React.useState<boolean | undefined>(undefined);
    const [error, setError] = React.useState<string | undefined>(undefined);
    const frame = React.useRef<HTMLIFrameElement>(null);
    const first = React.useRef(true);

    React.useEffect(() => {
        let live = true;
        host.isApproved(hash).then(value => live && setApproved(value));
        const listening = host.onDidChangeApproval(() => host.isApproved(hash).then(value => live && setApproved(value)));
        return () => { live = false; listening.dispose(); };
    }, [hash]);

    // Built once per version of the code; theme changes are sent as messages instead of reloading the view.
    const source = React.useMemo(() => wardenDocument(viewDocument(props.html, host.theme())), [props.html]);

    const send = (message: { response: unknown } | { event: ViewEvent }) =>
        frame.current?.contentWindow?.postMessage({ channel: CHANNEL, ...message }, '*');

    React.useEffect(() => {
        if (!approved) {
            return;
        }
        const onMessage = (event: MessageEvent) => {
            const data = event.data as { channel?: string, request?: ViewRequest, report?: ViewReport } | undefined;
            if (!frame.current || event.source !== frame.current.contentWindow || data?.channel !== CHANNEL) {
                return;
            }
            if (data.request && typeof data.request.id === 'number') {
                const id = data.request.id;
                host.handle(spec, data.request).then(
                    result => send({ response: { id, result } }),
                    failure => send({ response: { id, error: failure instanceof Error ? failure.message : String(failure) } })
                );
            } else if (data.report?.report === 'error') {
                setError(String(data.report.message).slice(0, 4000));
            } else if (data.report?.report === 'ready') {
                setError(undefined);
            }
        };
        window.addEventListener('message', onMessage);
        const theming = host.onDidChangeTheme(() => {
            const theme = host.theme();
            send({ event: { event: 'theme', vars: theme.vars, dark: theme.dark } });
        });
        return () => { window.removeEventListener('message', onMessage); theming.dispose(); };
    }, [approved, spec]);

    React.useEffect(() => {
        if (first.current) {
            first.current = false;
        } else if (approved) {
            send({ event: { event: 'changed' } });
        }
    }, [props.revision]);

    if (approved === undefined) {
        return <div className='cicerone-view-message'>Loading…</div>;
    }
    if (!approved) {
        return <div className='cicerone-view-consent'>
            <div className={`cicerone-view-consent-icon ${codicon('shield')}`} />
            <p><b>This view runs code</b> from <code>{props.path}</code>.</p>
            <p className='cicerone-dim'>It runs in a sandbox with no network access. It can read {spec.files
                ? <>only <code>{spec.files}</code></>
                : <>the files of this workspace, except hidden ones such as <code>.env</code> and <code>.git</code></>}, open files in the editor,
                and run the actions this workbench declares. It asks again whenever its code changes.</p>
            <div className='cicerone-view-consent-actions'>
                <button className='theia-button' onClick={() => host.approve(hash)}><span className={codicon('play')} /> Run this view</button>
                <button className='theia-button secondary' onClick={props.onOpenCode}><span className={codicon('code')} /> Read the code</button>
            </div>
        </div>;
    }
    return <>
        {error && <div className='cicerone-view-error' role='alert'>
            <span className={codicon('error')} />
            <div className='cicerone-view-error-text' title={error}>{error.split('\n')[0]}</div>
            <button className='theia-button secondary' title='Send the error to the agent and ask it to fix the view' onClick={() => props.onAskAgent(error)}>Ask the agent to fix it</button>
            <button className='cicerone-view-error-close' title='Dismiss' onClick={() => setError(undefined)}><span className={codicon('close')} /></button>
        </div>}
        <iframe ref={frame} className='cicerone-view-frame' sandbox='allow-scripts' srcDoc={source} title={spec.title} />
    </>;
}
