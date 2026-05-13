import { MODULE_ID } from './bbh-constants.mjs';
import { applyDefaultDocumentSheets, registerDocumentSheets } from './bbh-document-sheets.mjs';
import { runHarvest, registerHarvestHooks } from './bbh-harvest.mjs';
import { refreshRollTableCompendiumChoices, registerSettings, registerSettingsHooks } from './bbh-settings.mjs';

Hooks.once('init', () => {
	registerSettings();
	registerSettingsHooks();
	registerHarvestHooks();
});

Hooks.once('setup', () => {
	registerDocumentSheets();
});

Hooks.once('ready', async () => {
	refreshRollTableCompendiumChoices();
	Hooks.on('createCompendium', refreshRollTableCompendiumChoices);
	Hooks.on('deleteCompendium', refreshRollTableCompendiumChoices);
	Hooks.on('updateCompendium', refreshRollTableCompendiumChoices);

	await applyDefaultDocumentSheets();
	const module = game.modules.get(MODULE_ID);
	if (module) {
		module.api = {
			runHarvest,
		};
	}
});
