import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event, URI } from '@theia/core';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { EditValidator } from '@cicerone/core/lib/browser';
import { EMPTY_WORKBENCH, parseWorkbench, SKILLS_DIRECTORY, splitFrontMatter, WORKBENCH_FILE, WorkbenchConfig } from '../common/workbench.js';

/** Keeps the workbench description in step with the file it lives in. */
@injectable()
export class WorkbenchService implements EditValidator {

    @inject(FileService) protected readonly fileService: FileService;
    @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService;

    protected _config: WorkbenchConfig = EMPTY_WORKBENCH;
    protected _problems: string[] = [];
    protected _exists = false;
    protected lastText: string | undefined;
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    /** Resolves after the first load, so consumers do not act on the empty default. */
    readonly ready: Promise<void> = new Promise(resolve => this.markReady = resolve);
    protected markReady!: () => void;

    @postConstruct()
    protected init(): void {
        this.workspaceService.roots.then(() => this.reload()).finally(() => this.markReady());
        this.workspaceService.onWorkspaceChanged(() => this.reload());
        this.fileService.onDidFilesChange(event => {
            const uri = this.uri;
            if (uri && event.contains(uri)) {
                this.reload();
            }
        });
    }

    get root(): URI | undefined {
        return this.workspaceService.tryGetRoots()[0]?.resource;
    }

    get uri(): URI | undefined {
        return this.root?.resolve(WORKBENCH_FILE);
    }

    get config(): WorkbenchConfig { return this._config; }
    get problems(): readonly string[] { return this._problems; }
    get exists(): boolean { return this._exists; }

    async reload(): Promise<void> {
        const uri = this.uri;
        let text: string | undefined;
        if (uri) {
            try {
                text = (await this.fileService.read(uri)).value;
            } catch {
                text = undefined;
            }
        }
        if (text === this.lastText) {
            return;
        }
        this.lastText = text;
        this._exists = text !== undefined;
        const parsed = text === undefined ? { config: EMPTY_WORKBENCH, problems: [] } : parseWorkbench(text);
        this._config = parsed.config;
        this._problems = parsed.problems;
        this.onDidChangeEmitter.fire();
    }

    /** Tells the agent what is wrong with a workbench description or a skill while it is still writing it. */
    validate(_uri: URI, path: string, proposed: string): string[] | undefined {
        if (path === WORKBENCH_FILE) {
            return parseWorkbench(proposed).problems;
        }
        const skill = new RegExp(`^${SKILLS_DIRECTORY.replace('.', '\\.')}/([^/]+)/SKILL\\.md$`).exec(path);
        if (skill) {
            const { fields } = splitFrontMatter(proposed);
            const problems: string[] = [];
            if (fields.name !== skill[1]) {
                problems.push(`The front matter must start the file and contain "name: ${skill[1]}" (the folder name).`);
            }
            if (!fields.description) {
                problems.push('The front matter needs a one-line "description:".');
            }
            return problems;
        }
        return undefined;
    }
}
