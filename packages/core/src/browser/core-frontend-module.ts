import '../../src/browser/style/index.css';
import { ContainerModule } from '@theia/core/shared/inversify';
import { bindContributionProvider, CommandContribution, PreferenceContribution, ResourceResolver } from '@theia/core';
import {
    bindViewContribution, FrontendApplicationContribution, KeybindingContribution, RemoteConnectionProvider, ServiceConnectionProvider, WidgetFactory
} from '@theia/core/lib/browser';
import { Agent, ToolProvider } from '@theia/ai-core';
import { ChatAgent, DefaultChatAgentId } from '@theia/ai-chat';
import { WORKSPACE_TOOLS_PATH, WorkspaceTools } from '../common/workspace-tools.js';
import { ChatWelcomeMessageProvider } from '@theia/ai-chat-ui/lib/browser/chat-tree-view';
import { ChatSessionsWelcomeMessageProvider } from '@theia/ai-ide/lib/browser/chat-sessions-welcome-message-provider';
import { ActivityService } from './activity-service.js';
import { CiceroneWelcomeMessageProvider } from './welcome-message.js';
import { ActivityWidget } from './activity-widget.js';
import { BuiltinSkillContribution } from './builtin-skills.js';
import { EditValidator } from './edit-validator.js';
import { CICERONE_AGENT_ID, CiceroneAgent, CiceroneToolProvider } from './cicerone-agent.js';
import { ActivityViewContribution, CiceronePreferenceSchema, CiceroneContribution, TourViewContribution } from './core-contribution.js';
import { ProposalResourceResolver, StopPresenter } from './stop-presenter.js';
import { EditTool, FindTool, ReadTool, RunTool, ShowTool, SkillLibrary, SkillTool } from './tools.js';
import { TourService } from './tour-service.js';
import { TourWidget } from './tour-widget.js';
import { WorkspaceDocuments } from './workspace-documents.js';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
    // The empty chat introduces this product, not the Theia IDE's agents (which ship switched off here).
    if (isBound(ChatWelcomeMessageProvider)) {
        unbind(ChatWelcomeMessageProvider);
    }
    bind(CiceroneWelcomeMessageProvider).toSelf().inSingletonScope();
    bind(ChatWelcomeMessageProvider).toService(CiceroneWelcomeMessageProvider);
    bind(ChatWelcomeMessageProvider).to(ChatSessionsWelcomeMessageProvider).inSingletonScope();

    bind(PreferenceContribution).toConstantValue({ schema: CiceronePreferenceSchema });

    bind(WorkspaceTools).toDynamicValue(ctx => {
        const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<WorkspaceTools>(WORKSPACE_TOOLS_PATH);
    }).inSingletonScope();

    bind(WorkspaceDocuments).toSelf().inSingletonScope();
    bind(TourService).toSelf().inSingletonScope();
    bind(ActivityService).toSelf().inSingletonScope();
    bind(StopPresenter).toSelf().inSingletonScope();
    bind(ProposalResourceResolver).toSelf().inSingletonScope();
    bind(ResourceResolver).toService(ProposalResourceResolver);

    // The tool set, in the order the model sees it. Also registered globally so the AI configuration can list them.
    bindContributionProvider(bind, CiceroneToolProvider);
    bindContributionProvider(bind, BuiltinSkillContribution);
    bindContributionProvider(bind, EditValidator);
    bind(SkillLibrary).toSelf().inSingletonScope();
    for (const tool of [ReadTool, FindTool, EditTool, ShowTool, RunTool, SkillTool]) {
        bind(tool).toSelf().inSingletonScope();
        bind(CiceroneToolProvider).toService(tool);
        bind(ToolProvider).toService(tool);
    }

    bind(CiceroneAgent).toSelf().inSingletonScope();
    bind(Agent).toService(CiceroneAgent);
    bind(ChatAgent).toService(CiceroneAgent);
    if (isBound(DefaultChatAgentId)) {
        rebind(DefaultChatAgentId).toConstantValue({ id: CICERONE_AGENT_ID });
    } else {
        bind(DefaultChatAgentId).toConstantValue({ id: CICERONE_AGENT_ID });
    }

    bind(TourWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({ id: TourWidget.ID, createWidget: () => ctx.container.get(TourWidget) })).inSingletonScope();
    bindViewContribution(bind, TourViewContribution);
    bind(ActivityWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({ id: ActivityWidget.ID, createWidget: () => ctx.container.get(ActivityWidget) })).inSingletonScope();
    bindViewContribution(bind, ActivityViewContribution);

    bind(CiceroneContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(CiceroneContribution);
    bind(CommandContribution).toService(CiceroneContribution);
    bind(KeybindingContribution).toService(CiceroneContribution);
});
