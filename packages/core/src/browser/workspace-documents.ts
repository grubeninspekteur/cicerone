import { inject, injectable } from '@theia/core/shared/inversify';
import { URI } from '@theia/core';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { MonacoTextModelService } from '@theia/monaco/lib/browser/monaco-text-model-service';
import { MonacoWorkspace } from '@theia/monaco/lib/browser/monaco-workspace';
import * as monaco from '@theia/monaco-editor-core';

/**
 * Workspace-relative paths in, text out. The single place that decides what the agent may touch
 * (the workspace, nothing else) and what "the current text of a file" means (the open editor's
 * buffer if there is one, including unsaved typing, otherwise the file on disk).
 */
@injectable()
export class WorkspaceDocuments {

    @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService;
    @inject(FileService) protected readonly fileService: FileService;
    @inject(MonacoTextModelService) protected readonly textModelService: MonacoTextModelService;
    @inject(MonacoWorkspace) protected readonly monacoWorkspace: MonacoWorkspace;

    get root(): URI | undefined {
        return this.workspaceService.tryGetRoots()[0]?.resource;
    }

    requireRoot(): URI {
        const root = this.root;
        if (!root) {
            throw new Error('No folder is open.');
        }
        return root;
    }

    /** @throws when the path leaves the workspace */
    resolve(path: string): URI {
        const root = this.requireRoot();
        const cleaned = path.trim().replace(/^\.\//, '').replace(/^\/+/, '');
        const target = (cleaned === '' || cleaned === '.' ? root : root.resolve(cleaned)).normalizePath();
        if (!root.isEqualOrParent(target)) {
            throw new Error(`'${path}' is outside the workspace.`);
        }
        return target;
    }

    relative(uri: URI | string): string {
        const target = typeof uri === 'string' ? new URI(uri) : uri;
        return this.root?.relative(target)?.toString() ?? target.path.toString();
    }

    /** The text a human would see for this file right now, or undefined when the file does not exist. */
    async read(uri: URI): Promise<string | undefined> {
        const open = this.monacoWorkspace.getTextDocument(uri.toString());
        if (open) {
            return open.getText();
        }
        try {
            return (await this.fileService.read(uri)).value;
        } catch {
            return undefined;
        }
    }

    /**
     * Replaces `length` characters at `offset` through the editor model, so the change lands in an
     * open editor as an ordinary, undoable edit, and saves.
     */
    async replace(uri: URI, offset: number, length: number, text: string): Promise<void> {
        const reference = await this.textModelService.createModelReference(uri);
        try {
            const model = reference.object.textEditorModel;
            const start = model.getPositionAt(offset);
            const end = model.getPositionAt(offset + length);
            model.pushStackElement();
            model.pushEditOperations([], [{ range: monaco.Range.fromPositions(start, end), text, forceMoveMarkers: true }], () => []);
            model.pushStackElement();
            await reference.object.save();
        } finally {
            reference.dispose();
        }
    }

    async create(uri: URI, text: string): Promise<void> {
        await this.fileService.create(uri, text, { overwrite: false });
    }

    async delete(uri: URI): Promise<void> {
        await this.fileService.delete(uri, { useTrash: false });
    }
}
