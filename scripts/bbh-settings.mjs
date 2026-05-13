import { FLAGS, MODULE_ID, SETTINGS } from './bbh-constants.mjs';
import { format, localize } from './bbh-utils.mjs';

const CUSTOM_TYPE_KEY = '__custom__';

export function registerSettings() {
	game.settings.register(MODULE_ID, SETTINGS.creatureTypeTables, {
		name: 'BBH.SETTINGS.CreatureTypeTables.Name',
		hint: 'BBH.SETTINGS.CreatureTypeTables.Hint',
		scope: 'world',
		config: false,
		type: new foundry.data.fields.ArrayField(
			new foundry.data.fields.SchemaField({
				type: new foundry.data.fields.StringField({ required: true, blank: false, initial: 'all' }),
				uuid: new foundry.data.fields.StringField({ required: true, blank: true, initial: '' }),
			}),
			{ initial: [] },
		),
	});

	game.settings.register(MODULE_ID, SETTINGS.autoRollHarvest, {
		name: 'BBH.SETTINGS.AutoRollHarvest.Name',
		hint: 'BBH.SETTINGS.AutoRollHarvest.Hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.BooleanField({ initial: false }),
	});

	game.settings.register(MODULE_ID, SETTINGS.autoEnableQuantityOnNewTables, {
		name: 'BBH.SETTINGS.AutoEnableQuantityOnNewTables.Name',
		hint: 'BBH.SETTINGS.AutoEnableQuantityOnNewTables.Hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.BooleanField({ initial: false }),
	});

	game.settings.register(MODULE_ID, SETTINGS.rollTableCompendium, {
		name: 'BBH.SETTINGS.RollTableCompendium.Name',
		hint: 'BBH.SETTINGS.RollTableCompendium.Hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.StringField({
			required: true,
			blank: true,
			initial: '',
			choices: () => getRollTableCompendiumChoices(),
		}),
	});

	game.settings.register(MODULE_ID, SETTINGS.debug, {
		name: 'BBH.SETTINGS.Debug.Name',
		hint: 'BBH.SETTINGS.Debug.Hint',
		scope: 'world',
		config: false,
		type: new foundry.data.fields.BooleanField({ initial: false }),
	});

	registerHarvestAttemptSettingsBySize();

	game.settings.register(MODULE_ID, SETTINGS.lastOpenedRollTableUuid, {
		scope: 'client',
		config: false,
		type: new foundry.data.fields.StringField({ required: false, blank: true, initial: '' }),
	});

	game.settings.registerMenu(MODULE_ID, SETTINGS.creatureTypeTables, {
		name: 'BBH.SETTINGS.CreatureTypeTables.Menu.Name',
		label: 'BBH.SETTINGS.CreatureTypeTables.Menu.Label',
		hint: 'BBH.SETTINGS.CreatureTypeTables.Menu.Hint',
		icon: 'fas fa-table-list',
		type: HarvestTableMappingMenu,
		restricted: true,
	});

	game.settings.registerMenu(MODULE_ID, SETTINGS.harvestAttemptsMenu, {
		name: 'BBH.SETTINGS.HarvestAttemptsBySize.Menu.Name',
		label: 'BBH.SETTINGS.HarvestAttemptsBySize.Menu.Label',
		hint: 'BBH.SETTINGS.HarvestAttemptsBySize.Menu.Hint',
		icon: 'fas fa-list-ol',
		type: HarvestAttemptsBySizeMenu,
		restricted: true,
	});
}

function registerHarvestAttemptSettingsBySize() {
	const actorSizes = CONFIG.DND5E?.actorSizes ?? {};
	for (const [sizeKey, sizeData] of Object.entries(actorSizes)) {
		const numerical = sizeData?.numerical;
		const initial = numerical === undefined ? 1 : Math.max(1, Math.floor(numerical));
		const sizeLabel = localize(sizeData?.label ?? sizeKey);
		game.settings.register(MODULE_ID, getHarvestAttemptsSettingKey(sizeKey), {
			name: format('BBH.SETTINGS.HarvestAttemptsBySize.Name', { size: sizeLabel }),
			hint: format('BBH.SETTINGS.HarvestAttemptsBySize.Hint', { size: sizeLabel }),
			scope: 'world',
			config: false,
			type: new foundry.data.fields.NumberField({ integer: true, min: 1, initial }),
		});
	}
}

export function registerSettingsHooks() {
	Hooks.on('preCreateRollTable', applyDefaultQuantityFlagToNewRollTable);
}

export function getCreatureTypeTableMappings() {
	return normalizeRawTableEntries(game.settings.get(MODULE_ID, SETTINGS.creatureTypeTables) ?? []).filter((entry) => entry.uuid);
}

export function isAutoRollHarvestEnabled() {
	return game.settings.get(MODULE_ID, SETTINGS.autoRollHarvest);
}

export function isAutoEnableQuantityOnNewTablesEnabled() {
	return game.settings.get(MODULE_ID, SETTINGS.autoEnableQuantityOnNewTables);
}

export function getHarvestAttemptsMaxForActor(actor) {
	const override = actor.getFlag(MODULE_ID, 'harvestMaxOverride');
	if (override !== undefined && override !== null && override !== '') {
		const overrideValue = Math.floor(override);
		if (overrideValue >= 1) return overrideValue;
	}

	const size = actor.system?.traits?.size;
	if (!size) return 1;

	const maxBySize = game.settings.get(MODULE_ID, getHarvestAttemptsSettingKey(size));
	const max = Math.floor(maxBySize || 1);
	return max < 1 ? 1 : max;
}

function getHarvestAttemptsSettingKey(size) {
	return `${SETTINGS.harvestAttemptsMaxBySizePrefix}.${size}`;
}

export function getConfiguredRollTableCompendium() {
	const value = game.settings.get(MODULE_ID, SETTINGS.rollTableCompendium);
	return typeof value === 'string' ? value.trim() : '';
}

export function refreshRollTableCompendiumChoices() {
	const settingKey = `${MODULE_ID}.${SETTINGS.rollTableCompendium}`;
	const setting = game.settings.settings.get(settingKey);
	if (!setting?.type) return;
	if (setting.type instanceof foundry.data.fields.StringField) {
		setting.type.choices = () => getRollTableCompendiumChoices();
	}
}

export function openCreatureTypeTablesMenu() {
	if (!game.user.isGM) return;
	new HarvestTableMappingMenu().render(true);
}

class HarvestTableMappingMenu extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
	static get DEFAULT_OPTIONS() {
		return foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
			id: `${MODULE_ID}-creature-type-tables`,
			tag: 'form',
			classes: [MODULE_ID],
			window: {
				title: localize('BBH.TABLES.WindowTitle'),
				icon: 'fa-solid fa-table-list',
				contentClasses: ['standard-form'],
			},
			position: {
				width: 720,
				height: 'auto',
			},
			actions: {
				addEntry: HarvestTableMappingMenu.prototype._onAddEntryAction,
				removeEntry: HarvestTableMappingMenu.prototype._onRemoveEntryAction,
				openUuid: HarvestTableMappingMenu.prototype._onOpenUuidAction,
				clearUuid: HarvestTableMappingMenu.prototype._onClearUuidAction,
				openTableSource: HarvestTableMappingMenu.prototype._onOpenTableSourceAction,
			},
			form: {
				handler: HarvestTableMappingMenu.onSubmitForm,
				closeOnSubmit: true,
			},
		});
	}

	static PARTS = {
		main: {
			template: `modules/${MODULE_ID}/templates/creature-type-tables.hbs`,
			root: true,
			scrollable: ['.bugbears-harvester-settings-list'],
		},
	};

	async _prepareContext() {
		const entries = await getEditableTableEntries();
		const usedTypes = new Set(entries.map((entry) => entry.type));
		const rows = entries.map((entry, index) => ({
			index,
			key: entry.type,
			customType:
				entry.type === CUSTOM_TYPE_KEY ? ''
				: isKnownCreatureType(entry.type) || entry.type === 'all' ? ''
				: entry.type,
			isCustom: entry.type === CUSTOM_TYPE_KEY || !(isKnownCreatureType(entry.type) || entry.type === 'all'),
			previousType: isKnownCreatureType(entry.type) || entry.type === 'all' ? entry.type : CUSTOM_TYPE_KEY,
			uuid: entry.uuid,
			label: entry.label,
			documentName: entry.documentName,
			displayValue: entry.documentName || entry.uuid,
			typeOptions: getCreatureTypeOptions(entry.type, usedTypes),
		}));

		return { rows };
	}

	async _onRender(context, options) {
		await super._onRender(context, options);

		this.element.querySelectorAll('[data-harvester-drop]').forEach((dropTarget) => {
			dropTarget.addEventListener('dragover', this.#onDragOver);
			dropTarget.addEventListener('drop', this.#onDropUuid.bind(this));
		});

		this.element.querySelectorAll('[data-uuid-display]').forEach((input) => {
			input.addEventListener('change', this.#onUuidChange.bind(this));
			input.addEventListener('contextmenu', this.#onUuidContextMenu.bind(this));
		});

		this.element.querySelectorAll('[data-entry-index]').forEach((row) => {
			this.#updateOpenUuidButtonState(row);
			this.#updateCustomTypeEditButtonState(row);
		});

		this.element.querySelectorAll('[data-entry-type-select]').forEach((select) => {
			select.addEventListener('change', this.#onTypeSelectChange.bind(this));
		});

		this.element.querySelectorAll('[data-custom-type-edit]').forEach((button) => {
			button.addEventListener('click', this.#onEditCustomTypeClick.bind(this));
		});
	}

	static async onSubmitForm(_event, _form, formData) {
		const expanded = foundry.utils.expandObject(formData.object);
		const entries = Object.values(expanded?.entries ?? {})
			.map((entry) => normalizeRawEntry(resolveEntryTypeForSave(entry)))
			.filter(Boolean);

		await game.settings.set(MODULE_ID, SETTINGS.creatureTypeTables, entries);
		await ensureHarvestTableFlagForEntries(entries);
	}

	async _onAddEntryAction(event) {
		event.preventDefault();
		const entries = this._getDraftEntries();
		entries.push({ type: getNextAvailableCreatureType(entries), uuid: '' });
		await this._replaceEntries(entries);
	}

	async #onTypeSelectChange(event) {
		const select = event.currentTarget;
		const row = select.closest('[data-entry-index]');
		this.#updateCustomTypeEditButtonState(row);
		if (select.value !== CUSTOM_TYPE_KEY) return;
		await this.#promptForCustomType(row, select);
	}

	async #onEditCustomTypeClick(event) {
		event.preventDefault();
		const button = event.currentTarget;
		const row = button.closest('[data-entry-index]');
		if (!row) return;
		const select = row.querySelector('[data-entry-type-select]');
		if (!select) return;
		await this.#promptForCustomType(row, select);
	}

	async #promptForCustomType(row, select) {
		if (!row || !select) return;
		const current = this.#getRowCustomTypeValue(row);
		const result = await promptForCustomCreatureType(current);
		if (!result) {
			if (select.dataset.previousType) select.value = select.dataset.previousType;
			this.#updateCustomTypeEditButtonState(row);
			return;
		}
		this.#setRowCustomTypeValue(row, result);
		select.dataset.previousType = CUSTOM_TYPE_KEY;
		select.value = CUSTOM_TYPE_KEY;
		this.#updateCustomTypeEditButtonState(row);
	}

	async _onRemoveEntryAction(event, button) {
		event.preventDefault();
		const row = button.closest('[data-entry-index]');
		if (!row) return;

		const index = Number(row.dataset.entryIndex);
		const entries = this._getDraftEntries().filter((_entry, currentIndex) => currentIndex !== index);

		await this._replaceEntries(entries);
	}

	async #onDropUuid(event) {
		event.preventDefault();
		const dropData = foundry.applications.ux.TextEditor.implementation.getDragEventData(event.originalEvent ?? event);
		if (!dropData?.uuid) return;

		const document = await fromUuid(dropData.uuid);
		if (!(document instanceof RollTable)) {
			ui.notifications.warn(localize('BBH.WARN.DropRollTable'));
			return;
		}

		const dropZone = event.target?.closest?.('[data-harvester-drop]') ?? this.element?.querySelector?.('[data-harvester-drop]');
		if (!dropZone) return;

		const uuidInput = dropZone.querySelector('[data-uuid-value]');
		const displayInput = dropZone.querySelector('[data-uuid-display]');
		if (!uuidInput || !displayInput) return;

		uuidInput.value = document.uuid;
		displayInput.value = document.name;
		this.#updateOpenUuidButtonState(dropZone.closest('[data-entry-index]'), document);
		await ensureHarvestTableFlag(document);
		await setLastOpenedRollTableUuid(document.uuid);
	}

	async #onUuidChange(event) {
		const displayInput = event.currentTarget;
		const row = displayInput.closest('[data-entry-index]');
		if (!row) return;

		const uuidInput = row.querySelector('[data-uuid-value]');
		if (!uuidInput) return;

		const candidate = displayInput.value.trim();
		if (!candidate) {
			uuidInput.value = '';
			this.#updateOpenUuidButtonState(row, null);
			return;
		}

		const document = await fromUuid(candidate).catch(() => null);
		if (document instanceof RollTable) {
			uuidInput.value = document.uuid;
			displayInput.value = document.name;
			this.#updateOpenUuidButtonState(row, document);
			await ensureHarvestTableFlag(document);
			await setLastOpenedRollTableUuid(document.uuid);
			return;
		}

		const matchedByName = await this.#findRollTableByName(candidate);
		if (matchedByName instanceof RollTable) {
			uuidInput.value = matchedByName.uuid;
			displayInput.value = matchedByName.name;
			this.#updateOpenUuidButtonState(row, matchedByName);
			await ensureHarvestTableFlag(matchedByName);
			await setLastOpenedRollTableUuid(matchedByName.uuid);
			return;
		}

		uuidInput.value = '';
		ui.notifications.warn(localize('BBH.WARN.TableNameOrUuidNotResolved'));
		this.#updateOpenUuidButtonState(row, document);
	}

	async _onOpenUuidAction(event, button) {
		event.preventDefault();
		const row = button.closest('[data-entry-index]');
		if (!row) return;

		const uuidInput = row.querySelector('[data-uuid-value]');
		const uuid = uuidInput?.value?.trim() ?? '';
		if (!uuid) return;

		const document = await fromUuid(uuid).catch(() => null);
		if (!(document instanceof RollTable)) {
			ui.notifications.warn(localize('BBH.WARN.UuidNotRollTable'));
			this.#updateOpenUuidButtonState(row, document);
			return;
		}

		this.#updateOpenUuidButtonState(row, document);
		await setLastOpenedRollTableUuid(document.uuid);
		document.sheet?.render(true);
	}

	async _onOpenTableSourceAction(event) {
		event.preventDefault();
		const row = event.currentTarget?.closest?.('[data-entry-index]');
		await this.#openRollTableSource(this.#getRowUuid(row));
	}

	async _onClearUuidAction(event, button) {
		event.preventDefault();
		const row = button.closest('[data-entry-index]');
		if (!row) return;

		const uuidInput = row.querySelector('[data-uuid-value]');
		const displayInput = row.querySelector('[data-uuid-display]');
		if (uuidInput) uuidInput.value = '';
		if (displayInput) displayInput.value = '';
		this.#updateOpenUuidButtonState(row, null);
	}

	async #onUuidContextMenu(event) {
		event.preventDefault();
		const row = event.currentTarget?.closest?.('[data-entry-index]');
		await this.#openRollTableSource(this.#getRowUuid(row));
	}

	async #openRollTableSource(preferredUuid = '') {
		const configuredPackId = getConfiguredRollTableCompendium();
		const sourceUuid = preferredUuid?.trim() || getLastOpenedRollTableUuid() || this.#getFirstConfiguredUuid();
		const sourceDocument = sourceUuid ? await fromUuid(sourceUuid).catch(() => null) : null;
		if (sourceDocument instanceof RollTable) await setLastOpenedRollTableUuid(sourceDocument.uuid);
		const sourceFolder = sourceDocument instanceof RollTable ? sourceDocument.folder : null;
		if (sourceFolder) expandFolderPath(sourceFolder);

		const sourcePackId = sourceDocument instanceof RollTable ? (sourceDocument.pack ?? '') : '';
		const targetPackId = sourcePackId || configuredPackId;
		if (targetPackId) {
			const pack = game.packs?.get(targetPackId);
			if (pack) {
				await focusCompendiumRollTable(pack, sourceDocument);
				pack.render(true);
				return;
			}
		}

		const sidebar = ui.sidebar;
		if (!sidebar) return;

		sidebar.expand?.();
		if (typeof sidebar.changeTab === 'function') {
			sidebar.changeTab('tables', 'primary');
			return;
		}

		if (typeof sidebar.activateTab === 'function') {
			sidebar.activateTab('tables');
		}
	}

	#getRowUuid(row) {
		const uuidInput = row?.querySelector?.('[data-uuid-value]');
		return uuidInput?.value?.trim?.() ?? '';
	}

	#getRowCustomTypeValue(row) {
		const input = row?.querySelector?.('[data-custom-type-value]');
		return input?.value?.trim?.() ?? '';
	}

	#setRowCustomTypeValue(row, value) {
		const input = row?.querySelector?.('[data-custom-type-value]');
		if (!input) return;
		input.value = value;
	}

	#getFirstConfiguredUuid() {
		const first = this._getDraftEntries().find((entry) => entry.uuid);
		return first?.uuid ?? '';
	}

	async #findRollTableByName(name) {
		const lowerName = name.toLowerCase();
		const worldMatch = game.tables.find((table) => table.name?.toLowerCase() === lowerName);
		if (worldMatch instanceof RollTable) return worldMatch;

		const configuredPackId = getConfiguredRollTableCompendium();
		if (!configuredPackId) return null;

		const pack = game.packs?.get(configuredPackId);
		if (!pack || pack.documentName !== 'RollTable') return null;

		const index = await pack.getIndex({ fields: ['name'] });
		const indexEntry = index.find((entry) => typeof entry?.name === 'string' && entry.name.toLowerCase() === lowerName);
		if (!indexEntry?._id) return null;

		const uuid = `Compendium.${pack.collection}.RollTable.${indexEntry._id}`;
		const document = await fromUuid(uuid).catch(() => null);
		return document instanceof RollTable ? document : null;
	}

	#updateOpenUuidButtonState(row, document = undefined) {
		if (!row) return;

		const button = row.querySelector("[data-action='openUuid']");
		const uuidInput = row.querySelector('[data-uuid-value]');
		if (!button || !uuidInput) return;

		const uuid = uuidInput.value.trim();
		if (!uuid) {
			button.disabled = true;
			return;
		}

		if (document !== undefined) {
			button.disabled = !(document instanceof RollTable);
			return;
		}

		button.disabled = false;
	}

	#updateCustomTypeEditButtonState(row) {
		if (!row) return;
		const select = row.querySelector('[data-entry-type-select]');
		const button = row.querySelector('[data-custom-type-edit]');
		if (!select || !button) return;
		button.classList.toggle('is-hidden', select.value !== CUSTOM_TYPE_KEY);
	}

	async _replaceEntries(entries) {
		await game.settings.set(MODULE_ID, SETTINGS.creatureTypeTables, entries);
		await this.render({ force: true });
	}

	_getDraftEntries() {
		const formData = this.form ? new foundry.applications.ux.FormDataExtended(this.form).object : {};
		const expanded = foundry.utils.expandObject(formData);
		const rawEntries = expanded?.entries ?? {};

		if (Object.keys(rawEntries).length) {
			return Object.values(rawEntries)
				.map((entry) => normalizeRawEntry(resolveEntryTypeForSave(entry), { keepEmptyUuid: true }))
				.filter(Boolean);
		}

		return normalizeRawTableEntries(game.settings.get(MODULE_ID, SETTINGS.creatureTypeTables) ?? [], {
			keepEmptyUuid: true,
		});
	}

	#onDragOver(event) {
		event.preventDefault();
	}
}

class HarvestAttemptsBySizeMenu extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
	static get DEFAULT_OPTIONS() {
		return foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
			id: `${MODULE_ID}-harvest-attempts-by-size`,
			tag: 'form',
			classes: [MODULE_ID],
			window: {
				title: localize('BBH.SETTINGS.HarvestAttemptsBySize.WindowTitle'),
				icon: 'fa-solid fa-list-ol',
				contentClasses: ['standard-form'],
			},
			position: {
				width: 560,
				height: 'auto',
			},
			form: {
				handler: HarvestAttemptsBySizeMenu.onSubmitForm,
				closeOnSubmit: true,
			},
		});
	}

	static PARTS = {
		main: {
			template: `modules/${MODULE_ID}/templates/harvest-attempts-by-size.hbs`,
			root: true,
		},
	};

	async _prepareContext() {
		return {
			rows: getHarvestAttemptSizeRows(),
		};
	}

	static async onSubmitForm(_event, _form, formData) {
		const expanded = foundry.utils.expandObject(formData.object);
		const values = expanded?.sizes ?? {};
		for (const row of getHarvestAttemptSizeRows()) {
			const raw = values[row.key];
			if (raw === '' || raw === undefined || raw === null) {
				await game.settings.set(MODULE_ID, row.settingKey, row.defaultValue);
				continue;
			}
			const next = Math.max(1, Math.floor(raw));
			await game.settings.set(MODULE_ID, row.settingKey, next);
		}
	}
}

function getHarvestAttemptSizeRows() {
	const rows = [];
	for (const [sizeKey, sizeData] of Object.entries(CONFIG.DND5E?.actorSizes ?? {})) {
		const settingKey = getHarvestAttemptsSettingKey(sizeKey);
		const currentValue = game.settings.get(MODULE_ID, settingKey);
		const defaultValue = getDefaultHarvestAttemptValue(sizeData?.numerical);
		rows.push({
			key: sizeKey,
			settingKey,
			label: localize(sizeData?.label ?? sizeKey),
			value: Math.max(1, Math.floor(currentValue || defaultValue)),
			defaultValue,
		});
	}
	return rows;
}

function getDefaultHarvestAttemptValue(numerical) {
	if (numerical === undefined) return 1;
	return Math.max(1, Math.floor(numerical));
}

function normalizeRawTableEntries(value, options = {}) {
	if (Array.isArray(value)) {
		return value.map((entry) => normalizeRawEntry(entry, options)).filter(Boolean);
	}

	if (value && typeof value === 'object') {
		return Object.entries(value)
			.flatMap(([type, uuids]) => {
				return (Array.isArray(uuids) ? uuids : []).map((uuid) => normalizeRawEntry({ type, uuid }, options));
			})
			.filter(Boolean);
	}

	return [];
}

async function getEditableTableEntries() {
	const rawEntries = normalizeRawTableEntries(game.settings.get(MODULE_ID, SETTINGS.creatureTypeTables) ?? [], {
		keepEmptyUuid: true,
	});
	return Promise.all(rawEntries.map((entry) => decorateEntry(entry)));
}

function normalizeRawEntry(entry, { keepEmptyUuid = false } = {}) {
	const rawType = (typeof entry?.type === 'string' ? entry.type : 'all').trim().toLowerCase() || 'all';
	const type = rawType === CUSTOM_TYPE_KEY ? 'all' : rawType;
	const uuid = typeof entry?.uuid === 'string' ? entry.uuid.trim() : '';
	if (!uuid && !keepEmptyUuid) return null;

	return {
		type,
		uuid,
	};
}

async function decorateEntry(entry) {
	return {
		...entry,
		label: getCreatureTypeLabel(entry.type),
		documentName: await getDocumentName(entry.uuid),
	};
}

function getCreatureTypeOptions(selectedType = 'all', usedTypes = new Set()) {
	const options = [
		{ key: 'all', label: localize('BBH.COMMON.All') },
		{ key: CUSTOM_TYPE_KEY, label: localize('BBH.TABLES.CustomType') },
	];

	const isKnownType = selectedType === 'all' || selectedType in (CONFIG.DND5E.creatureTypes ?? {});
	const selectedOptionValue = isKnownType ? selectedType : CUSTOM_TYPE_KEY;

	for (const [key, data] of Object.entries(CONFIG.DND5E.creatureTypes ?? {})) {
		options.push({
			key,
			label: localize(data?.label ?? key),
		});
	}
	return options
		.filter((option) => option.key === selectedOptionValue || option.key === CUSTOM_TYPE_KEY || !usedTypes.has(option.key))
		.map((option) => ({
			...option,
			selected: option.key === selectedOptionValue,
		}));
}

function getCreatureTypeLabel(type) {
	if (type === 'all') return localize('BBH.COMMON.All');
	if (!isKnownCreatureType(type)) return format('BBH.TABLES.CustomTypeDisplay', { value: type });
	return localize(CONFIG.DND5E.creatureTypes?.[type]?.label ?? type);
}

function getNextAvailableCreatureType(entries = []) {
	const usedTypes = new Set(entries.map((entry) => entry?.type?.toLowerCase?.() ?? '').filter(Boolean));
	const candidates = ['all', ...Object.keys(CONFIG.DND5E.creatureTypes ?? {})];
	return candidates.find((type) => !usedTypes.has(type)) ?? 'all';
}

function getNormalizedCustomTypeValue(value) {
	if (typeof value !== 'string') return '';
	const normalized = value.trim().toLowerCase();
	if (!normalized || normalized === CUSTOM_TYPE_KEY) return '';
	return normalized;
}

function isKnownCreatureType(type) {
	return typeof type === 'string' && type in (CONFIG.DND5E.creatureTypes ?? {});
}

function resolveEntryTypeForSave(entry) {
	if (!entry || typeof entry !== 'object') return entry;
	const type = typeof entry.type === 'string' ? entry.type.trim() : '';
	if (type !== CUSTOM_TYPE_KEY) return entry;

	const customType = getNormalizedCustomTypeValue(entry.customType);
	return {
		...entry,
		type: customType || 'all',
	};
}

async function promptForCustomCreatureType(initialValue = '') {
	const inputName = `${MODULE_ID}-custom-creature-type`;
	const content = `
		<div class="form-group">
			<label for="${inputName}">${localize('BBH.TABLES.CustomTypePromptLabel')}</label>
			<input type="text" id="${inputName}" name="${inputName}" value="${foundry.utils.escapeHTML(initialValue)}" />
			<p class="hint">${localize('BBH.TABLES.CustomTypePromptHint')}</p>
		</div>
	`;

	const dialogResult = await foundry.applications.api.DialogV2.wait({
		window: { title: localize('BBH.TABLES.CustomTypePromptTitle') },
		content,
		buttons: [
			{
				action: 'save',
				icon: 'fa-solid fa-save',
				label: localize('BBH.TABLES.Save'),
				default: true,
				callback: (_event, button, dialog) => {
					const value = dialog.element?.querySelector?.(`#${inputName}`)?.value;
					return getNormalizedCustomTypeValue(value);
				},
			},
			// {
			// 	action: 'cancel',
			// 	icon: 'fa-solid fa-xmark',
			// 	label: localize('BBH.TABLES.Cancel'),
			// },
		],
	});

	if (!dialogResult) return '';
	return getNormalizedCustomTypeValue(dialogResult);
}

function getRollTableCompendiumChoices() {
	const choices = {
		'': localize('BBH.SETTINGS.RollTableCompendium.None'),
	};
	const treePaths = getCompendiumFolderPathsFromTree();

	const packs = game.packs?.contents ?? (typeof game.packs?.values === 'function' ? Array.from(game.packs.values()) : []);

	for (const pack of packs) {
		if (pack.documentName !== 'RollTable') continue;
		const folderPath = treePaths.get(pack.collection) ?? getCompendiumFolderPathForPack(pack);
		choices[pack.collection] = formatCompendiumChoiceLabel(pack, folderPath);
	}

	return choices;
}

function formatCompendiumChoiceLabel(pack, folderPath) {
	const title = pack?.title?.trim?.() || pack?.collection?.trim?.() || '';
	if (!folderPath) return title;

	const segments = folderPath
		.split(' > ')
		.map((part) => part.trim())
		.filter(Boolean);
	if (!segments.length) return title;

	const pathLabel = segments.join(' / ');
	return `${title} (${pathLabel})`;
}

function expandFolderPath(folder) {
	const visited = new Set();
	let current = folder;
	while (current && !visited.has(current)) {
		visited.add(current);
		const uuid = typeof current?.uuid === 'string' ? current.uuid.trim() : '';
		if (uuid) game.folders._expanded[uuid] = true;
		const parent = current?.folder;
		if (!parent) break;
		current = typeof parent === 'string' ? game.folders?.get(parent) : parent;
	}
}

function getLastOpenedRollTableUuid() {
	const value = game.settings.get(MODULE_ID, SETTINGS.lastOpenedRollTableUuid);
	return typeof value === 'string' ? value.trim() : '';
}

async function setLastOpenedRollTableUuid(uuid) {
	const value = typeof uuid === 'string' ? uuid.trim() : '';
	if (!value) return;
	if (value === getLastOpenedRollTableUuid()) return;
	await game.settings.set(MODULE_ID, SETTINGS.lastOpenedRollTableUuid, value);
}

async function focusCompendiumRollTable(pack, sourceDocument) {
	if (!pack || !(sourceDocument instanceof RollTable)) return;
	const sourcePackId = sourceDocument.pack ?? '';
	if (!sourcePackId || sourcePackId !== pack.collection) return;

	const targetId = sourceDocument.id ?? '';
	if (!targetId) return;

	const focusWhenRendered = (app, html) => {
		const root = html?.[0] ?? html;
		if (!root?.querySelector) return;
		const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(targetId) : targetId;
		const selectors = [`[data-entry-id="${escapedId}"]`, `[data-document-id="${escapedId}"]`, `[data-uuid="${escapedId}"]`];

		const target = selectors.map((selector) => root.querySelector(selector)).find(Boolean);

		if (!target) return;
		target.scrollIntoView({ block: 'center', behavior: 'smooth' });
		target.classList.add('bugbears-harvester-focus-target');
		window.setTimeout(() => target.classList.remove('bugbears-harvester-focus-target'), 1500);
	};

	const hookId = Hooks.on('renderCompendium', (app, html) => {
		if (app?.collection !== pack) return;
		Hooks.off('renderCompendium', hookId);
		focusWhenRendered(app, html);
	});
}

function getCompendiumFolderPathsFromTree() {
	const map = new Map();
	const root = game.packs?.tree;
	if (!root) return map;

	const walk = (node, parentNames = []) => {
		const folderName = typeof node?.folder?.name === 'string' ? node.folder.name.trim() : '';
		const nextNames = folderName ? [...parentNames, folderName] : parentNames;

		for (const entry of node?.entries ?? []) {
			const collection = typeof entry?.collection === 'string' ? entry.collection.trim() : '';
			if (!collection) continue;
			map.set(collection, nextNames.join(' > '));
		}

		for (const child of node?.children ?? []) {
			walk(child, nextNames);
		}
	};

	walk(root, []);
	return map;
}

function getCompendiumFolderPathForPack(pack) {
	const configuredFolderId = typeof pack?.config?.folder === 'string' ? pack.config.folder.trim() : '';
	const rootFolder = configuredFolderId ? game.folders?.get(configuredFolderId) : null;
	if (!rootFolder) return '';

	const names = [];
	const visited = new Set();
	let current = rootFolder;
	while (current && !visited.has(current)) {
		visited.add(current);
		const name = typeof current?.name === 'string' ? current.name.trim() : '';
		if (name) names.unshift(name);
		const parent = current?.folder;
		if (!parent) break;
		current = typeof parent === 'string' ? game.folders?.get(parent) : parent;
	}
	return names.join(' > ');
}

async function getDocumentName(uuid) {
	if (!uuid) return '';
	return (await fromUuid(uuid).catch(() => null))?.name ?? '';
}

async function ensureHarvestTableFlagForEntries(entries) {
	const tables = await Promise.all(entries.map((entry) => fromUuid(entry.uuid).catch(() => null)));
	await Promise.all(tables.map((table) => ensureHarvestTableFlag(table)));
}

async function ensureHarvestTableFlag(table) {
	if (!(table instanceof RollTable)) return;
	const isHarvestTable = table.getFlag(MODULE_ID, FLAGS.table.isHarvestTable);
	const updates = [];

	if (isHarvestTable !== true) {
		updates.push(table.setFlag(MODULE_ID, FLAGS.table.isHarvestTable, true));
	}

	if (updates.length) await Promise.all(updates);
}

function applyDefaultQuantityFlagToNewRollTable(table, createData) {
	if (!(table instanceof RollTable)) return;
	if (!isAutoEnableQuantityOnNewTablesEnabled()) return;
	const quantityFlagPath = `flags.${MODULE_ID}.${FLAGS.table.enableQuantity}`;
	if (foundry.utils.getProperty(createData, quantityFlagPath) !== undefined) return;
	table.updateSource({
		flags: {
			[MODULE_ID]: {
				[FLAGS.table.enableQuantity]: true,
			},
		},
	});
}
