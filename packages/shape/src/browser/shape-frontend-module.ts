import '../../src/browser/style/shape.css';
import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core';
import { FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { BuiltinSkillContribution, EditValidator } from '@cicerone/core/lib/browser';
import { WORKBENCH_SKILL, WORKBENCH_SKILL_DESCRIPTION, WORKBENCH_SKILL_NAME } from '../common/workbench-skill.js';
import { SHAPED_VIEW_FACTORY, ShapedViewOptions, ShapedViewWidget } from './shaped-view-widget.js';
import { ViewDataService } from './view-data.js';
import { WorkbenchApplier } from './workbench-applier.js';
import { WorkbenchService } from './workbench-service.js';

export default new ContainerModule(bind => {
    bind(WorkbenchService).toSelf().inSingletonScope();
    bind(EditValidator).toService(WorkbenchService);
    bind(ViewDataService).toSelf().inSingletonScope();

    bind(ShapedViewWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: SHAPED_VIEW_FACTORY,
        createWidget: (options: ShapedViewOptions) => {
            const child = container.createChild();
            child.bind(ShapedViewOptions).toConstantValue(options);
            return child.get(ShapedViewWidget);
        }
    })).inSingletonScope();

    bind(WorkbenchApplier).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(WorkbenchApplier);
    bind(CommandContribution).toService(WorkbenchApplier);

    // How to reshape the workbench is itself a skill: it costs one line of prompt until someone asks for it.
    bind(BuiltinSkillContribution).toConstantValue({
        getSkills: () => [{ name: WORKBENCH_SKILL_NAME, description: WORKBENCH_SKILL_DESCRIPTION, content: WORKBENCH_SKILL }]
    });
});
