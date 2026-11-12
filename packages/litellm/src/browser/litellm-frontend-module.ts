import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, RemoteConnectionProvider, ServiceConnectionProvider } from '@theia/core/lib/browser';
import { CommandContribution, PreferenceContribution } from '@theia/core';
import { LITELLM_GATEWAY_PATH, LiteLlmGateway, LiteLlmPreferencesSchema } from '../common/litellm-protocol.js';
import { LiteLlmConnectCommandContribution } from './litellm-connect-command.js';
import { LiteLlmFrontendContribution } from './litellm-frontend-contribution.js';

export default new ContainerModule(bind => {
    bind(PreferenceContribution).toConstantValue({ schema: LiteLlmPreferencesSchema });
    bind(LiteLlmGateway).toDynamicValue(ctx => {
        const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<LiteLlmGateway>(LITELLM_GATEWAY_PATH);
    }).inSingletonScope();
    bind(LiteLlmFrontendContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(LiteLlmFrontendContribution);
    bind(LiteLlmConnectCommandContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(LiteLlmConnectCommandContribution);
});
