import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core';
import { WORKSPACE_TOOLS_PATH, WorkspaceTools } from '../common/workspace-tools.js';
import { WorkspaceToolsImpl } from './workspace-tools-impl.js';

export default new ContainerModule(bind => {
    bind(WorkspaceToolsImpl).toSelf().inSingletonScope();
    bind(WorkspaceTools).toService(WorkspaceToolsImpl);
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(WORKSPACE_TOOLS_PATH, () => ctx.container.get(WorkspaceTools))).inSingletonScope();
});
