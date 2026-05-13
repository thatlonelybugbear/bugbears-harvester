import { FLAGS, MODULE_ID } from './bbh-constants.mjs';
import { localize } from './bbh-utils.mjs';

const SHEET_IDS = {
	rollTable: `${MODULE_ID}.HarvesterRollTableSheet`,
	tableResult: `${MODULE_ID}.HarvesterTableResultConfig`,
};

let HarvesterRollTableSheetClass;
let HarvesterTableResultConfigClass;

export function registerDocumentSheets() {
	const DocumentSheetConfig = foundry.applications.apps.DocumentSheetConfig;

	DocumentSheetConfig.registerSheet(RollTable, MODULE_ID, getHarvesterRollTableSheetClass(), {
		label: localize('BBH.SHEETS.RollTable.Label'),
	});

	DocumentSheetConfig.registerSheet(TableResult, MODULE_ID, getHarvesterTableResultConfigClass(), {
		label: localize('BBH.SHEETS.TableResult.Label'),
	});
}

export async function applyDefaultDocumentSheets() {
	if (!game.user.isGM) return;

	const current = foundry.utils.deepClone(game.settings.get('core', 'sheetClasses') ?? {});
	let changed = false;

	changed ||= setDefaultSheet(current, 'RollTable', 'base', SHEET_IDS.rollTable);
	changed ||= setDefaultSheet(current, 'TableResult', 'base', SHEET_IDS.tableResult);

	if (!changed) return;
	await game.settings.set('core', 'sheetClasses', current);
}

function setDefaultSheet(settings, documentName, type, newId) {
	settings[documentName] ??= {};
	const existing = settings[documentName][type];
	if (existing === newId) return false;
	settings[documentName][type] = newId;
	return true;
}

function getHarvesterRollTableSheetClass() {
	if (HarvesterRollTableSheetClass) return HarvesterRollTableSheetClass;

	const BaseRollTableSheet = globalThis.dnd5e?.applications?.RollTableSheet5e ?? foundry.applications.sheets.RollTableSheet;

	HarvesterRollTableSheetClass = class HarvesterRollTableSheet extends BaseRollTableSheet {
		static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
			actions: {
				applySkillToAll: HarvesterRollTableSheet.prototype._onApplySkillToAllAction,
			},
		});

		static get PARTS() {
			const parts = foundry.utils.deepClone(super.PARTS);
			parts.results = {
				...parts.results,
				template: `modules/${MODULE_ID}/templates/roll-table-results.hbs`,
			};
			parts.summary = {
				...parts.summary,
				template: `modules/${MODULE_ID}/templates/roll-table-summary.hbs`,
			};
			return parts;
		}

		async _preparePartContext(partId, context, options) {
			context = await super._preparePartContext(partId, context, options);
			const isHarvestTable = !!this.document.getFlag(MODULE_ID, FLAGS.table.isHarvestTable);
			const hasQuantityColumn = !!this.document.getFlag(MODULE_ID, FLAGS.table.enableQuantity);

			if (partId === 'summary') {
				context.isHarvestTable = isHarvestTable;
				context.hasQuantityColumn = hasQuantityColumn;
			}

			if (partId === 'results') {
				context.isHarvestTable = isHarvestTable;
				context.hasQuantityColumn = hasQuantityColumn;
				context.harvestBulkSkillOptions = getSkillOptions('');
			}

			return context;
		}

		async _prepareResult(result) {
			const context = await super._prepareResult(result);
			const harvestSkill = result.getFlag(MODULE_ID, FLAGS.result.skill) ?? '';

			return {
				...context,
				harvestSkill,
				harvestDc: result.getFlag(MODULE_ID, FLAGS.result.dc) ?? '',
				harvestQuantity: result.getFlag(MODULE_ID, FLAGS.result.quantity) ?? '',
				harvestSkillOptions: getSkillOptions(harvestSkill),
			};
		}

		async _onApplySkillToAllAction(event, button) {
			event.preventDefault();

			const scope = button?.closest?.('.bugbears-harvester-results-tab') ?? this.element;
			const bulkSelect = scope?.querySelector?.('[data-harvester-bulk-skill]');
			if (!bulkSelect) return;

			const skill = bulkSelect.value ?? '';
			scope.querySelectorAll?.(`select[name$='.flags.${MODULE_ID}.skill']`).forEach((input) => {
				input.value = skill;
			});
		}
	};

	return HarvesterRollTableSheetClass;
}

function getHarvesterTableResultConfigClass() {
	if (HarvesterTableResultConfigClass) return HarvesterTableResultConfigClass;

	const BaseTableResultConfig = foundry.applications.sheets.TableResultConfig;

	HarvesterTableResultConfigClass = class HarvesterTableResultConfig extends BaseTableResultConfig {
		static get PARTS() {
			const parts = foundry.utils.deepClone(super.PARTS);
			parts.sheet = {
				...parts.sheet,
				template: `modules/${MODULE_ID}/templates/table-result-config.hbs`,
			};
			return parts;
		}

		async _prepareContext(options) {
			const context = await super._prepareContext(options);
			const table = this.document.parent;
			const isHarvestTable = !!table?.getFlag(MODULE_ID, FLAGS.table.isHarvestTable);
			const hasQuantityColumn = !!table?.getFlag(MODULE_ID, FLAGS.table.enableQuantity);
			const harvestSkill = this.document.getFlag(MODULE_ID, FLAGS.result.skill) ?? '';

			context.isHarvestTable = isHarvestTable;
			context.hasQuantityColumn = hasQuantityColumn;
			context.harvestSkill = harvestSkill;
			context.harvestDc = this.document.getFlag(MODULE_ID, FLAGS.result.dc) ?? '';
			context.harvestQuantity = this.document.getFlag(MODULE_ID, FLAGS.result.quantity) ?? '';
			context.harvestSkillOptions = getSkillOptions(harvestSkill);
			return context;
		}
	};

	return HarvesterTableResultConfigClass;
}

function getSkillOptions(selectedValue = '') {
	return Object.entries(CONFIG.DND5E.skills ?? {}).map(([value, data]) => ({
		value,
		label: localize(data?.label ?? value),
		selected: value === selectedValue,
	}));
}
