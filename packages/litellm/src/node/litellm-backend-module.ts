import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, PreferenceContribution, RpcConnectionHandler } from '@theia/core';
import { LITELLM_GATEWAY_PATH, LiteLlmGateway, LiteLlmPreferencesSchema } from '../common/litellm-protocol.js';
import { LiteLlmGatewayImpl } from './litellm-gateway-impl.js';

export default new ContainerModule(bind => {
    bind(PreferenceContribution).toConstantValue({ schema: LiteLlmPreferencesSchema });
    bind(LiteLlmGatewayImpl).toSelf().inSingletonScope();
    bind(LiteLlmGateway).toService(LiteLlmGatewayImpl);
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(LITELLM_GATEWAY_PATH, () => ctx.container.get(LiteLlmGateway))).inSingletonScope();
});
