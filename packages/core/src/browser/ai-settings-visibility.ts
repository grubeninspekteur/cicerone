import { PreferenceSchemaService } from '@theia/core';
import { AI_CONFIGURATION_OPEN_PREFERENCE_ID, HideAiPreferencesContribution } from '@theia/ai-core/lib/browser/hide-ai-preferences-contribution';

/**
 * Keeps provider keys, gateway URL and the other AI settings in the ordinary Settings view.
 *
 * Theia AI hides every `ai-features.*` setting from that view and shows a note instead that they
 * "have moved to the AI Configuration view". That view is part of `@theia/ai-ide`, which Cicerone
 * leaves out together with the agents it brings, so in this application the note pointed at
 * nothing and the settings could only be reached by editing settings.json.
 *
 * The contribution that does the hiding is bound anonymously and re-hides on every schema change,
 * so it can neither be rebound nor undone from outside; replacing its one method is the narrowest
 * way to turn it off. What remains hidden is the note itself.
 */
export function keepAiSettingsInSettingsView(): void {
    (HideAiPreferencesContribution.prototype as unknown as { hideAiPreferences(service: PreferenceSchemaService): void }).hideAiPreferences =
        function (service: PreferenceSchemaService): void {
            const note = service.getSchemaProperties().get(AI_CONFIGURATION_OPEN_PREFERENCE_ID);
            if (note && !note.hidden) {
                service.updateSchemaProperty(AI_CONFIGURATION_OPEN_PREFERENCE_ID, { ...note, hidden: true });
            }
        };
}
