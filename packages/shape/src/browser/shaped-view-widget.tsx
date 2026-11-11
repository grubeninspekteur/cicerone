import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core';
import { codicon, Message, ReactWidget } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { Markdown } from '@cicerone/core/lib/browser';
import { ViewSpec } from '../common/workbench.js';
import { ViewData, ViewDataService, ViewGroup, ViewItem } from './view-data.js';
import { WorkbenchService } from './workbench-service.js';

export const SHAPED_VIEW_FACTORY = 'cicerone.view';
export const ShapedViewOptions = Symbol('ShapedViewOptions');
export interface ShapedViewOptions { viewId: string }

export const shapedViewWidgetId = (viewId: string) => `${SHAPED_VIEW_FACTORY}:${viewId}`;
export const actionCommandId = (actionId: string) => `cicerone.action.${actionId}`;

/** A view that exists because the workbench description says so. One class renders every kind. */
@injectable()
export class ShapedViewWidget extends ReactWidget {

    @inject(ShapedViewOptions) protected readonly options: ShapedViewOptions;
    @inject(WorkbenchService) protected readonly workbench: WorkbenchService;
    @inject(ViewDataService) protected readonly dataService: ViewDataService;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(FileService) protected readonly fileService: FileService;
    @inject(CommandService) protected readonly commands: CommandService;

    protected data: ViewData | undefined;
    protected loading = false;
    protected stale = true;
    protected refreshTimer: ReturnType<typeof setTimeout> | undefined;

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
        return <div className='cicerone-view-body'>
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
