import { FLAGS, MODULE_ID } from './bbh-constants.mjs';
import { getCreatureTypeTableMappings, getHarvestAttemptsMaxForActor, isAutoRollHarvestEnabled, openCreatureTypeTablesMenu } from './bbh-settings.mjs';
import { debugLog, format, infoLog, localize, parseNonNegativeInteger } from './bbh-utils.mjs';

const DEBUG_PREFIX = `${MODULE_ID} |`;
const QUERY_PROMPT = `${MODULE_ID}.harvestPromptRequest`;
const QUERY_MARK = `${MODULE_ID}.harvestMarkRequest`;
const RECENT_DRAG_QUANTITIES = new Map();
const RECENT_DRAG_TTL_MS = 15000;

export function registerHarvestHooks() {
	Hooks.on('getSceneControlButtons', addSceneControlButton);
	Hooks.on('renderChatMessageHTML', bindHarvestChatActions);
	Hooks.on('preCreateChatMessage', addRollTableQuantityToChatMessage);
	Hooks.on('createChatMessage', appendCompendiumRollTableQuantitiesToChatMessage);
	Hooks.on('dropActorSheetData', applyQuantityToDroppedActorSheetData);
	Hooks.once('ready', registerHarvestQueries);
}

export function registerHarvestKeybindings() {
	// Intentionally unwired. Kept as placeholder for later reuse.
}

export async function runHarvest({ actor, target } = {}) {
	const harvestingActor = actor instanceof Actor ? actor : resolveHarvestingActor();
	if (!harvestingActor) {
		ui.notifications.warn(localize('BBH.WARN.SelectOne.Actor'));
		return null;
	}

	let targetToken, targetActor;
	if (target) {
		if (target instanceof Token) targetToken = target;
		else if (target instanceof TokenDocument) targetToken = target.object;
		else if (target instanceof Actor) targetToken = target.getActiveTokens()[0];
	} else {
		targetToken = getSingleTargetToken();
	}
	targetActor = targetToken?.actor;
	if (!targetToken || !targetActor) return null;
	if (!isHarvestableTargetActor(targetActor)) {
		ui.notifications.info(localize('BBH.WARN.TargetMustBeAtZeroHp'));
		return null;
	}
	if (hasReachedHarvestAttemptLimit(targetActor)) {
		ui.notifications.info(getHarvestAttemptsReachedMessage(targetActor));
		return null;
	}

	const creatureTypeKeys = getCreatureTypeKeys(targetActor);
	const creatureType = creatureTypeKeys[0] ?? 'custom';
	const tables = await resolveHarvestTables(creatureTypeKeys);
	const table = tables[0];
	if (!table) {
		ui.notifications.warn(format('BBH.WARN.NoHarvestTableForType', { creatureType }));
		return null;
	}

	const payload = {
		actorUuid: harvestingActor.uuid,
		targetTokenUuid: targetToken.document?.uuid,
		tableUuid: table.uuid,
		creatureType,
		requesterUserId: game.user.id,
	};
	await postHarvestSkillPrompt(payload);
	return payload;
}

async function executeHarvest(payload, selectedSkill, promptMessage = null) {
	const context = await hydrateHarvestPayload(payload);
	if (!context) return null;

	const { actor, targetActor, table, creatureType } = context;
	if (!isHarvestableTargetActor(targetActor)) {
		ui.notifications.info(localize('BBH.WARN.TargetMustBeAtZeroHp'));
		return null;
	}
	if (hasReachedHarvestAttemptLimit(targetActor)) {
		ui.notifications.info(getHarvestAttemptsReachedMessage(targetActor));
		return null;
	}
	const { entries: resolved } = await resolveTableHarvestResults(table);
	const skill = typeof selectedSkill === 'string' ? selectedSkill.trim() : '';
	if (!skill) return null;
	const relevant = resolved.filter((entry) => entry.skill === skill);
	if (!relevant.length) return null;
	const alreadyHarvested = getHarvestedResultIds(targetActor, table.uuid, skill);
	const pending = relevant.filter((entry) => !alreadyHarvested.has(entry.result.id));
	debugLog(`${DEBUG_PREFIX} executeHarvest:selection`, {
		actor: actor?.name,
		targetActor: targetActor.name,
		table: table?.name,
		tableUuid: table?.uuid,
		skill,
		resolved: resolved.length,
		relevant: relevant.length,
		alreadyHarvested: alreadyHarvested.size,
		pending: pending.length,
	});
	if (!pending.length) return null;

	const [roll] =
		(await actor.rollSkill(
			{ skill },
			{ configure: !isAutoRollHarvestEnabled() },
			{
				speaker: ChatMessage.getSpeaker({ actor }),
				flavor: format('BBH.CHAT.RollFlavor', { actorName: actor.name, targetName: targetActor.name }),
			},
		)) ?? [];

	if (game.user.isGM) {
		await incrementHarvestAttempts(targetActor);
	} else {
		await requestGmIncrementHarvestAttempts(targetActor.uuid);
	}

	const total = typeof roll?.total === 'number' ? roll.total : 0;
	const succeededEntries = pending.filter((entry) => total >= entry.dc);
	const creationRequests = [];
	const rewardEntries = [];
	for (const entry of succeededEntries) {
		const quantity = await resolveQuantity(entry.result, actor, targetActor, table);
		creationRequests.push({ item: entry.item, quantity });
		rewardEntries.push({
			resultName: entry.result.name || entry.result.description || localize('BBH.CHAT.UnnamedResult'),
			itemName: entry.item.name,
			dc: entry.dc,
			quantity,
		});
	}
	const created = await createHarvestItemsBatch(actor, creationRequests);
	if (succeededEntries.length) {
		const harvestedResultIds = succeededEntries.map((entry) => entry.result.id);
		if (game.user.isGM) {
			await markHarvestedResults(targetActor, table.uuid, skill, harvestedResultIds);
		} else {
			await requestGmMarkHarvestedResults({
				targetActorUuid: targetActor.uuid,
				tableUuid: table.uuid,
				skill,
				resultIds: harvestedResultIds,
			});
		}
	}

	const outcomeContent = buildHarvestOutcomeContent({
		actor,
		targetActor,
		creatureType,
		table,
		skill,
		total,
		successCount: succeededEntries.length,
		rewards: rewardEntries,
		showTableLine: game.user.isGM,
	});
	if (promptMessage) {
		await promptMessage.update({
			content: outcomeContent,
			flags: {
				[MODULE_ID]: {
					pendingHarvest: null,
				},
			},
		});
	} else {
		await ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content: outcomeContent,
		});
	}

	return {
		total,
		successCount: succeededEntries.length,
		checkedCount: pending.length,
		created,
	};
}

function addSceneControlButton(controls) {
	if (!controls || typeof controls !== 'object') return;

	if (!game.user.isGM) {
		const tokenControl = controls.tokens;
		if (!tokenControl?.tools || typeof tokenControl.tools !== 'object') return;
		tokenControl.tools[`${MODULE_ID}-harvest-target`] = {
			name: `${MODULE_ID}-harvest-target`,
			title: localize('BBH.CONTROLS.HarvestTarget'),
			icon: 'fas fa-scissors',
			button: true,
			onChange: (event, active) => {
				if (!active) return;
				const clickedTool = event?.target?.closest?.('[data-tool]')?.dataset?.tool;
				if (clickedTool !== `${MODULE_ID}-harvest-target`) return;
				const actor = resolveHarvestingActor();
				void runHarvest({ actor });
			},
		};
		return;
	}

	controls[`${MODULE_ID}-controls`] = {
		name: `${MODULE_ID}-controls`,
		order: 75,
		title: localize('BBH.CONTROLS.GroupTitle'),
		icon: 'fas fa-scissors',
		visible: true,
		activeTool: `${MODULE_ID}-home`,
		tools: {
			[`${MODULE_ID}-harvest-target`]: {
				name: `${MODULE_ID}-harvest-target`,
				order: 1,
				title: localize('BBH.CONTROLS.HarvestTarget'),
				icon: 'fas fa-scissors',
				button: true,
				onChange: (event, active) => {
					if (!active) return;
					const clickedTool = event?.target?.closest?.('[data-tool]')?.dataset?.tool;
					if (clickedTool !== `${MODULE_ID}-harvest-target`) return;
					const actor = resolveHarvestingActor();
					void runHarvest({ actor });
				},
			},
			[`${MODULE_ID}-reset-harvested`]: {
				name: `${MODULE_ID}-reset-harvested`,
				order: 2,
				title: localize('BBH.CONTROLS.ResetHarvestedResults'),
				icon: 'fas fa-rotate-left',
				button: true,
				onChange: (_event, active) => {
					if (!active) return;
					void resetHarvestedResultsForSelection();
				},
			},
			[`${MODULE_ID}-configure-tables`]: {
				name: `${MODULE_ID}-configure-tables`,
				order: 3,
				title: localize('BBH.CONTROLS.ConfigureTables'),
				icon: 'fas fa-table-list',
				button: true,
				onChange: (_event, active) => {
					if (!active) return;
					openCreatureTypeTablesMenu();
				},
			},
			[`${MODULE_ID}-home`]: {
				name: `${MODULE_ID}-home`,
				order: 99,
				title: localize('BBH.CONTROLS.GroupTitle'),
				icon: 'fas fa-house',
			},
		},
	};
}

// function onRenderChatMessageHtml(message, html) {
//   bindHarvestChatActions(message, html);
// }

function registerHarvestQueries() {
	CONFIG.queries[QUERY_PROMPT] = async (queryData) => {
		if (!game.user.isActiveGM) return false;
		if (!queryData?.payload) return false;
		await postHarvestSkillPrompt(queryData.payload, { createRequesterMessage: false, createGmMessage: true });
		return true;
	};
	CONFIG.queries[QUERY_MARK] = async (queryData) => {
		if (!game.user.isActiveGM) return false;
		if (!queryData?.request) return false;
		await applyHarvestMarkRequest(queryData.request);
		return true;
	};
}

function bindHarvestChatActions(message, root) {
	if (!root) return;

	root.querySelectorAll("[data-harvester-action='roll-skill']").forEach((button) => {
		if (button.dataset.harvesterBound === 'true') return;
		button.dataset.harvesterBound = 'true';
		button.addEventListener('click', async (event) => {
			event.preventDefault();
			const payload = message.getFlag(MODULE_ID, 'pendingHarvest');
			if (!payload) return;
			const selectedSkill = button.dataset.harvesterSkill?.trim() ?? '';
			if (!selectedSkill) return;
			button.disabled = true;
			await executeHarvest(payload, selectedSkill, message);
			button.disabled = false;
		});
	});

	root.querySelectorAll('.table-results li[data-bhh-quantity] a.content-link[data-link]').forEach((link) => {
		if (link.dataset.bbhQuantityDragBound === 'true') return;
		link.dataset.bbhQuantityDragBound = 'true';
		link.addEventListener('dragstart', onQuantityContentLinkDragStart);
	});
}

function resolveHarvestingActor() {
	const controlledActor = canvas.tokens.controlled[0]?.actor;
	if (game.user.isGM) return controlledActor;
	if (controlledActor) return controlledActor;
	return game.user.character ?? null;
}

function getSingleTargetToken() {
	const targets = Array.from(game.user.targets ?? []);
	const targetToken = targets[0];
	if (targets.length !== 1) {
		ui.notifications.warn(localize('BBH.WARN.SelectOne.Target'));
		return null;
	}
	if (!game.actors.get(targetToken.actor?.id) || !targetToken?.actor?.system) {
		ui.notifications.warn(localize('BBH.WARN.SelectOne.TargetActor'));
		return null;
	}
	if (!targetToken.actor.system?.isCreature) {
		ui.notifications.warn(localize('BBH.WARN.SelectOne.Creature'));
		return null;
	}
	return targetToken;
}

function getGmUserIds() {
	return ChatMessage.getWhisperRecipients('GM').map((user) => user.id);
}

async function resolveHarvestTables(creatureTypeKeys = []) {
	const entries = getCreatureTypeTableMappings();
	console.log(entries);
	const exact = entries.filter((entry) => getEntryTypeMatchKeys(entry.type).some((key) => creatureTypeKeys.includes(key)));
	console.log(exact);
	const fallback = entries.filter((entry) => entry.type === 'all');
	console.log(fallback);
	const exactDocuments = await resolveConfiguredHarvestTables(exact);
	console.log(exactDocuments);
	if (exactDocuments.length) return exactDocuments;
	return resolveConfiguredHarvestTables(fallback);
}

function getEntryTypeMatchKeys(rawType) {
	if (!rawType || typeof rawType !== 'string') return [];
	const value = rawType.toLowerCase().trim();
	if (!value) return [];

	const colonIndex = value.indexOf(':');
	if (colonIndex < 0) return [value];

	const baseType = value.slice(0, colonIndex).trim();
	const rawSubtypes = value.slice(colonIndex + 1).trim();
	if (!baseType || !rawSubtypes) return [value];

	const subtypeParts = rawSubtypes
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
	if (!subtypeParts.length) return [value];

	const expanded = [];
	for (const subtype of subtypeParts) {
		expanded.push(`${baseType}:${subtype}`);
		expanded.push(`${baseType} (${subtype})`);
	}
	return Array.from(new Set(expanded));
}

function _raceOrType(actor, dataType = 'all') {
	const systemData = actor?.system;
	if (!systemData?.details?.type) return {};

	let data = {};
	if (actor.type === 'character' || actor.type === 'npc') {
		data = foundry.utils.duplicate(systemData.details.type);
		data.race = systemData.details.race?.identifier ?? data.value;
		data.type = actor.type;
	} else if (actor.type === 'group') {
		data = { type: 'group', value: systemData.type.value };
	} else if (actor.type === 'vehicle') {
		data = { type: 'vehicle', value: systemData.vehicleType };
	}

	const normalized = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v.toLowerCase() : v]));
	if (dataType === 'all') return normalized;
	return normalized[dataType];
}

function getCreatureTypeKeys(actor) {
	const all = _raceOrType(actor, 'all');
	const values = Object.values(all).filter((value) => typeof value === 'string' && value);
	const typeValue = all.value;
	const subtypeValue = all.subtype;
	const typeLabel = actor?.system?.details?.type?.label;
	if (typeValue && subtypeValue) values.push(`${typeValue}:${subtypeValue}`);
	// if (typeValue && subtypeValue) values.push(`${typeValue} (${subtypeValue})`);
	if (typeof typeLabel === 'string' && typeLabel.trim()) values.push(typeLabel.toLowerCase().trim());
	if (all.custom && subtypeValue) values.push(`${all.custom} (${subtypeValue})`);

	const subtypeParts =
		typeof subtypeValue === 'string' ?
			subtypeValue
				.split(',')
				.map((part) => part.trim())
				.filter(Boolean)
		:	[];
	for (const subtypePart of subtypeParts) {
		if (typeValue) {
			values.push(`${typeValue}:${subtypePart}`);
			values.push(`${typeValue} (${subtypePart})`);
		}
		if (all.custom) values.push(`${all.custom} (${subtypePart})`);
	}
	return Array.from(new Set(values));
}

async function resolveConfiguredHarvestTables(entries) {
	const documents = await Promise.all(entries.map((entry) => fromUuid(entry.uuid).catch(() => null)));
	const resolved = [];
	for (const [index, document] of documents.entries()) {
		const entry = entries[index];
		const isRollTable = document instanceof RollTable;
		const isHarvestTable = isRollTable ? document.getFlag(MODULE_ID, FLAGS.table.isHarvestTable) : null;
		if (!isRollTable || isHarvestTable !== true) {
			console.info(
				`${DEBUG_PREFIX} ${JSON.stringify({
					event: 'resolveConfiguredHarvestTables:excluded',
					entryUuid: entry?.uuid ?? null,
					resolved:
						isRollTable ? 'RollTable'
						: document ? document.documentName
						: null,
					tableUuid: isRollTable ? document.uuid : null,
					isHarvestTable,
				})}`,
			);
			continue;
		}
		resolved.push(document);
	}
	debugLog(
		`${DEBUG_PREFIX} ${JSON.stringify({
			event: 'resolveConfiguredHarvestTables:summary',
			input: entries.length,
			resolved: resolved.length,
			entryUuids: entries.map((entry) => entry?.uuid ?? null),
		})}`,
	);
	return resolved;
}

async function hydrateHarvestPayload(payload) {
	const [actor, targetToken, table] = await Promise.all([fromUuid(payload.actorUuid), payload.targetTokenUuid ? fromUuid(payload.targetTokenUuid) : null, fromUuid(payload.tableUuid)]);

	const targetActor = targetToken?.actor ?? null;
	if (!actor || !targetActor || !table) {
		ui.notifications.warn(localize('BBH.WARN.HarvestPayloadUnresolved'));
		return null;
	}

	return {
		actor,
		targetToken,
		targetActor,
		table,
		creatureType: payload.creatureType,
	};
}

async function resolveTableHarvestResults(table) {
	const entries = [];
	const tableResults = table?.results?.contents ?? Array.from(table?.results ?? []);
	const skipped = {
		missingSkillOrDc: 0,
		missingSkill: 0,
		missingDc: 0,
		missingItemUuid: 0,
		unresolvedItem: 0,
		nonItemDocument: 0,
	};
	debugLog(`${DEBUG_PREFIX} resolveTableHarvestResults:start`, {
		table: table?.name,
		tableUuid: table?.uuid,
		totalResults: tableResults.length,
	});
	for (const result of tableResults) {
		const skillFlag = result.getFlag(MODULE_ID, FLAGS.result.skill);
		const skill = typeof skillFlag === 'string' ? skillFlag.trim() : '';
		const dcRaw = result.getFlag(MODULE_ID, FLAGS.result.dc);
		const dc = parseNonNegativeInteger(dcRaw);
		const missingSkill = !skill;
		const missingDc = dc === null;
		if (missingSkill || missingDc) {
			skipped.missingSkillOrDc += 1;
			if (missingSkill) skipped.missingSkill += 1;
			if (missingDc) skipped.missingDc += 1;
			debugLog(`${DEBUG_PREFIX} resolveTableHarvestResults:skip-missing-skill-or-dc`, {
				resultId: result?.id,
				resultName: result?.name ?? result?.description ?? null,
				skill,
				dcRaw,
			});
			continue;
		}
		const item = await resolveResultItem(result, skipped);
		if (!isItemDocument(item)) {
			debugLog(`${DEBUG_PREFIX} resolveTableHarvestResults:skip-non-item`, {
				resultId: result?.id,
				resultName: result?.name ?? result?.description ?? null,
				documentUuid: result?.documentUuid ?? null,
				documentCollection: result?.documentCollection ?? null,
			});
			continue;
		}
		entries.push({ result, item, skill, dc });
	}
	if (!entries.length) {
		console.info(
			`${DEBUG_PREFIX} ${JSON.stringify({
				event: 'resolveTableHarvestResults:empty',
				table: table?.name ?? null,
				tableUuid: table?.uuid ?? null,
				totalResults: tableResults.length,
				skipped,
			})}`,
		);
	}
	debugLog(`${DEBUG_PREFIX} resolveTableHarvestResults:done`, {
		table: table?.name,
		tableUuid: table?.uuid,
		harvestableEntries: entries.length,
		skipped,
	});
	return { entries, skipped };
}

async function resolveResultItem(result, skipped = null) {
	const uuid = getResultItemUuid(result);
	if (!uuid) {
		if (skipped) skipped.missingItemUuid += 1;
		debugLog(`${DEBUG_PREFIX} resolveResultItem:no-uuid`, {
			resultId: result?.id,
			resultName: result?.name ?? result?.description ?? null,
			type: result?.type ?? null,
			source: result?.toObject?.() ?? null,
		});
		return null;
	}
	const document = await fromUuid(uuid).catch((error) => {
		if (skipped) skipped.unresolvedItem += 1;
		console.warn(`${DEBUG_PREFIX} resolveResultItem:fromUuid-failed`, {
			uuid,
			resultId: result?.id,
			error,
		});
		return null;
	});
	debugLog(`${DEBUG_PREFIX} resolveResultItem:resolved`, {
		uuid,
		documentName: document?.documentName ?? null,
		documentType: document?.type ?? null,
		name: document?.name ?? null,
	});
	if (!isItemDocument(document) && skipped) skipped.nonItemDocument += 1;
	return isItemDocument(document) ? document : null;
}

function getResultItemUuid(result) {
	const source = result?.toObject?.() ?? result?._source ?? {};
	const candidateUuids = [result?.documentUuid, source?.documentUuid, result?.source?.documentUuid];
	for (const candidate of candidateUuids) {
		const uuid = typeof candidate === 'string' ? candidate.trim() : '';
		if (uuid) return uuid;
	}

	const pairs = [
		[source?.documentCollection, source?.documentId],
		[result?.source?.documentCollection, result?.source?.documentId],
	];
	for (const [collectionRaw, idRaw] of pairs) {
		const collection = typeof collectionRaw === 'string' ? collectionRaw.trim() : '';
		const id = typeof idRaw === 'string' ? idRaw.trim() : '';
		if (collection && id) return `${collection}.${id}`;
	}
	return null;
}

async function resolveQuantity(result, actor, targetActor, table) {
	const quantityFlag = result.getFlag(MODULE_ID, FLAGS.result.quantity);
	const formula = typeof quantityFlag === 'string' ? quantityFlag.trim() : '';
	if (!formula) return 1;

	const roll = await new Roll(formula, {
		actor,
		target: targetActor,
		table,
	}).evaluate();

	const rolledTotal = typeof roll.total === 'number' ? roll.total : 1;
	return Math.max(1, Math.floor(rolledTotal));
}

function addRollTableQuantityToChatMessage(message, data) {
	if (foundry.utils.getProperty(data, `flags.${MODULE_ID}.quantityAppended`)) return;

	if (typeof data.content !== 'string' || !data.content.trim()) return;
	const content = data.content;

	const coreRollTableFlag = foundry.utils.getProperty(data, 'flags.core.RollTable');
	if (!hasWorldTableForCoreRollTableFlag(coreRollTableFlag)) return;
	const table = resolveTableFromCoreRollTableFlag(coreRollTableFlag);
	if (!table) return;

	const parser = new DOMParser();
	const doc = parser.parseFromString(content, 'text/html');
	const resultNodes = Array.from(doc.querySelectorAll('.table-results li'));
	if (!resultNodes.length) return;

	let changed = false;
	for (const [index, node] of resultNodes.entries()) {
		const result = resolveTableResultForNode(node, index, table);
		if (!result) continue;
		const quantityFlag = result.getFlag(MODULE_ID, FLAGS.result.quantity);
		const formula = typeof quantityFlag === 'string' ? quantityFlag.trim() : '';
		if (!formula) continue;

		const total = evaluateQuantityFormulaSync(formula);
		const resultName =
			typeof result?.name === 'string' ? result.name.trim()
			: typeof result?.description === 'string' ? result.description.trim()
			: '';
		node.setAttribute('data-bhh-quantity', `${total}`);
		const replaced = applyQuantityInlineToResultNode(node, total, resultName);
		if (!replaced) {
			const quantityEl = doc.createElement('p');
			quantityEl.classList.add('bbh-result-quantity');
			quantityEl.textContent = `Quantity: ${total} (${formula})`;
			node.appendChild(quantityEl);
		}
		changed = true;
	}

	if (!changed) return;
	const updatedContent = doc.body.innerHTML;
	data.content = updatedContent;
	foundry.utils.setProperty(data, `flags.${MODULE_ID}.quantityAppended`, true);
	const update = { content: updatedContent };
	foundry.utils.setProperty(update, `flags.${MODULE_ID}.quantityAppended`, true);
	message.updateSource(update);
}

async function appendCompendiumRollTableQuantitiesToChatMessage(message) {
	if (!game.user.isActiveGM) return;
	if (message.getFlag(MODULE_ID, 'quantityAppended')) return;
	if (typeof message.content !== 'string' || !message.content.trim()) return;
	const coreRollTableFlag = message.getFlag('core', 'RollTable');
	if (!coreRollTableFlag || hasWorldTableForCoreRollTableFlag(coreRollTableFlag)) return;

	const table = await resolveTableFromCoreRollTableFlagAsync(coreRollTableFlag);
	if (!table) return;

	const parser = new DOMParser();
	const doc = parser.parseFromString(message.content, 'text/html');
	const resultNodes = Array.from(doc.querySelectorAll('.table-results li'));
	if (!resultNodes.length) return;

	let changed = false;
	const rollTotal = message.rolls?.[0]?.total;
	const rolledResults = typeof rollTotal === 'number' ? table.getResultsForRoll(rollTotal) : [];
	for (const [index, node] of resultNodes.entries()) {
		const result = resolveTableResultForNode(node, index, table, rolledResults);
		if (!result) continue;
		const quantityFlag = result.getFlag(MODULE_ID, FLAGS.result.quantity);
		const formula = typeof quantityFlag === 'string' ? quantityFlag.trim() : '';
		if (!formula) continue;

		const total = evaluateQuantityFormulaSync(formula);
		const resultName =
			typeof result?.name === 'string' ? result.name.trim()
			: typeof result?.description === 'string' ? result.description.trim()
			: '';
		node.setAttribute('data-bhh-quantity', `${total}`);
		const replaced = applyQuantityInlineToResultNode(node, total, resultName);
		if (!replaced) {
			const quantityEl = doc.createElement('p');
			quantityEl.classList.add('bbh-result-quantity');
			quantityEl.textContent = `Quantity: ${total} (${formula})`;
			node.appendChild(quantityEl);
		}
		changed = true;
	}

	if (!changed) return;
	await message.update({
		content: doc.body.innerHTML,
		flags: { [MODULE_ID]: { quantityAppended: true } },
	});
}

function evaluateQuantityFormulaSync(formula) {
	const raw = typeof formula === 'string' ? formula.trim() : '';
	if (!raw) return 1;

	// Support common dice arithmetic synchronously for v13 chat pre-create hook.
	if (/[^0-9dD+\-*/().\s]/.test(raw)) return 1;
	const expression = raw.replace(/(\d*)d(\d+)/g, (_match, countRaw, facesRaw) => {
		const count = Math.max(1, Math.min(1000, Number.parseInt(countRaw || '1', 10) || 1));
		const faces = Math.max(1, Math.min(1000000, Number.parseInt(facesRaw, 10) || 1));
		let total = 0;
		for (let i = 0; i < count; i += 1) {
			total += Math.floor(Math.random() * faces) + 1;
		}
		return `${total}`;
	});

	try {
		const value = Function(`"use strict"; return (${expression});`)();
		if (!Number.isFinite(value)) return 1;
		return Math.max(1, Math.floor(value));
	} catch (_error) {
		return 1;
	}
}

function appendRollTableQuantitiesToRenderedMessage(message, html) {
	if (!(html instanceof HTMLElement)) return;
	if (html.querySelector('.bbh-result-quantity')) return;

	const coreRollTableFlag = message.getFlag('core', 'RollTable');
	const table = resolveTableFromCoreRollTableFlag(coreRollTableFlag);
	if (!table) return;

	const resultNodes = Array.from(html.querySelectorAll('.table-results li'));
	for (const [index, node] of resultNodes.entries()) {
		const result = resolveTableResultForNode(node, index, table);
		if (!result) continue;
		const quantityFlag = result.getFlag(MODULE_ID, FLAGS.result.quantity);
		const formula = typeof quantityFlag === 'string' ? quantityFlag.trim() : '';
		if (!formula) continue;

		const total = evaluateQuantityFormulaSync(formula);
		const resultName =
			typeof result?.name === 'string' ? result.name.trim()
			: typeof result?.description === 'string' ? result.description.trim()
			: '';
		node.setAttribute('data-bhh-quantity', `${total}`);
		const replaced = applyQuantityInlineToResultNode(node, total, resultName);
		if (!replaced) {
			const quantityEl = document.createElement('p');
			quantityEl.classList.add('bbh-result-quantity');
			quantityEl.textContent = `Quantity: ${total} (${formula})`;
			node.appendChild(quantityEl);
		}
	}
}

function applyQuantityInlineToResultNode(node, quantity, resultName) {
	const rawQty = typeof quantity === 'number' ? quantity : Number.parseFloat(quantity ?? '');
	const qty = Math.max(1, Math.floor(rawQty || 1));
	const safeName = typeof resultName === 'string' ? resultName.trim() : '';

	const link = node?.querySelector?.('a.content-link');
	if (link && link.textContent?.trim()) {
		link.setAttribute('data-bhh-quantity', `${qty}`);
		link.textContent = `${qty} x ${link.textContent.trim()}`;
		return true;
	}

	const description = node?.querySelector?.('.description');
	if (description && description.textContent?.trim()) {
		const current = description.textContent.trim();
		if (safeName && current.includes(safeName)) {
			description.textContent = current.replace(safeName, `${qty} x ${safeName}`);
		} else {
			description.textContent = `${qty} x ${current}`;
		}
		return true;
	}

	return false;
}

function onQuantityContentLinkDragStart(event) {
	const link = event?.currentTarget;
	const quantityRaw = link?.closest?.('li[data-bhh-quantity]')?.getAttribute?.('data-bhh-quantity');
	const parsedQuantity = Number.parseFloat(quantityRaw ?? '');
	const quantity = Math.max(1, Math.floor(parsedQuantity || 1));

	const uuid = typeof link?.dataset?.uuid === 'string' ? link.dataset.uuid.trim() : '';
	if (!uuid) return;
	RECENT_DRAG_QUANTITIES.set(uuid, { quantity, at: Date.now() });
}

function applyQuantityToDroppedActorSheetData(actor, _sheet, data) {
	if (!data || data.type !== 'Item') return;
	const rawQuantity = typeof data.bbhQuantity === 'number' ? data.bbhQuantity : Number.parseFloat(data.bbhQuantity ?? '');
	let resolvedRawQuantity = rawQuantity;
	if (!Number.isFinite(resolvedRawQuantity) || resolvedRawQuantity < 1) {
		const uuid = typeof data?.uuid === 'string' ? data.uuid.trim() : '';
		const recent = uuid ? RECENT_DRAG_QUANTITIES.get(uuid) : null;
		const ageMs = recent ? Date.now() - (typeof recent.at === 'number' ? recent.at : 0) : Number.POSITIVE_INFINITY;
		if (recent && ageMs >= 0 && ageMs <= RECENT_DRAG_TTL_MS) {
			resolvedRawQuantity = typeof recent.quantity === 'number' ? recent.quantity : resolvedRawQuantity;
		}
	}

	if (!Number.isFinite(resolvedRawQuantity) || resolvedRawQuantity < 1) return;
	const quantity = Math.max(1, Math.floor(resolvedRawQuantity));

	if (!data.data && data.uuid) {
		const droppedItem = fromUuidSync(typeof data.uuid === 'string' ? data.uuid.trim() : '');
		if (droppedItem?.documentName === 'Item') data.data = droppedItem.toObject();
	}
	if (!data.data || typeof data.data !== 'object') return;

	const droppedIdentifier = getItemIdentifier(data.data);
	if (droppedIdentifier && actor?.items?.contents) {
		const existing = actor.items.contents.find((item) => getItemIdentifier(item) === droppedIdentifier);
		if (existing) {
			const currentQuantity = getDocumentQuantity(existing);
			if (currentQuantity !== null) {
				actor.updateEmbeddedDocuments('Item', [{ _id: existing.id, 'system.quantity': currentQuantity + quantity }]).catch((error) => {
					console.error(`${DEBUG_PREFIX} dropActorSheetData:update-by-identifier failed`, error);
				});
				return false;
			}
		}
	}

	const current = foundry.utils.getProperty(data.data, 'system.quantity');
	if (Number.isFinite(current)) {
		foundry.utils.setProperty(data.data, 'system.quantity', quantity);
	} else {
		foundry.utils.setProperty(data.data, `flags.${MODULE_ID}.droppedQuantity`, quantity);
	}
}

function hasWorldTableForCoreRollTableFlag(coreRollTableFlag) {
	const tableId = typeof coreRollTableFlag === 'string' ? coreRollTableFlag : '';
	if (!tableId) return false;
	return game.tables?.get(tableId);
}

function resolveTableFromCoreRollTableFlag(coreRollTableFlag) {
	const tableId = typeof coreRollTableFlag === 'string' ? coreRollTableFlag : '';
	return tableId ? game.tables?.get(tableId) : null;
}

async function resolveTableFromCoreRollTableFlagAsync(coreRollTableFlag) {
	const tableId = typeof coreRollTableFlag === 'string' ? coreRollTableFlag : '';
	if (tableId) {
		const worldTable = game.tables?.get(tableId);
		if (worldTable) return worldTable;
	}

	const tableUuid = await resolveCompendiumRollTableUuidByIdAsync(tableId);
	if (!tableUuid) return null;

	const table = await fromUuid(tableUuid).catch(() => null);
	if (table instanceof RollTable) {
		return table;
	}

	return null;
}

async function resolveCompendiumRollTableUuidByIdAsync(tableId) {
	if (!tableId) return null;
	for (const pack of game.packs) {
		if (pack.documentName !== 'RollTable') continue;
		await pack.getIndex();
		if (!pack.index.get(tableId)) continue;
		return `Compendium.${pack.collection}.RollTable.${tableId}`;
	}
	return null;
}

function resolveTableResultForNode(node, index, table, fallbackResults = []) {
	const htmlResultId = (node?.getAttribute?.('data-result-id') ?? '').trim();
	if (htmlResultId) {
		const byHtmlId = table.results?.get(htmlResultId);
		if (byHtmlId) return byHtmlId;
	}

	const fallbackResult = fallbackResults[index];
	if (fallbackResult) {
		return fallbackResult;
	}

	const byLinkedDocument = resolveTableResultByLinkedDocument(node, table);
	if (byLinkedDocument) return byLinkedDocument;

	return null;
}

function resolveTableResultByLinkedDocument(node, table) {
	const link = node?.querySelector?.('a.content-link');
	if (!link) return null;

	const linkUuid = (link.getAttribute('data-uuid') ?? '').trim();
	const linkDocumentId = (link.getAttribute('data-id') ?? '').trim();
	if (!linkUuid && !linkDocumentId) return null;

	for (const result of table.results?.contents ?? []) {
		const resultUuid = getResultItemUuid(result);
		if (linkUuid && resultUuid === linkUuid) return result;
		if (linkDocumentId && resultUuid?.endsWith(`.${linkDocumentId}`)) return result;

		const source = result?.toObject?.() ?? result?._source ?? {};
		const sourceUuidValue = source?.documentUuid ?? source?.source?.documentUuid;
		const sourceDocumentUuid = typeof sourceUuidValue === 'string' ? sourceUuidValue.trim() : '';
		if (linkUuid && sourceDocumentUuid && sourceDocumentUuid === linkUuid) return result;
		if (linkDocumentId && sourceDocumentUuid?.endsWith(`.${linkDocumentId}`)) return result;
	}

	return null;
}

function createHarvestItemData(item, quantity) {
	const itemData = item.pack ? game.items.fromCompendium(item) : item.toObject();
	delete itemData._id;
	if (itemData.system?.quantity !== undefined) {
		itemData.system.quantity = quantity;
	}
	return [itemData];
}

function getItemIdentifier(itemData) {
	const rawIdentifier = foundry.utils.getProperty(itemData, 'system.identifier');
	const identifier = typeof rawIdentifier === 'string' ? rawIdentifier.trim() : '';
	return identifier || null;
}

function getDocumentQuantity(document) {
	const currentQuantity = foundry.utils.getProperty(document, 'system.quantity');
	return currentQuantity ?? null;
}

async function createHarvestItemsBatch(actor, entries) {
	const toCreate = [];
	const updateQuantities = new Map();
	const actorItemsByIdentifier = new Map();
	for (const existingItem of actor.items.contents) {
		const identifier = getItemIdentifier(existingItem);
		if (!identifier || actorItemsByIdentifier.has(identifier)) continue;
		actorItemsByIdentifier.set(identifier, existingItem);
	}

	for (const { item, quantity } of entries) {
		const createData = createHarvestItemData(item, quantity);
		for (const itemData of createData) {
			const identifier = getItemIdentifier(itemData);
			if (!identifier) {
				toCreate.push(itemData);
				continue;
			}
			const existingItem = actorItemsByIdentifier.get(identifier);
			if (!existingItem) {
				toCreate.push(itemData);
				continue;
			}
			const currentQuantity = getDocumentQuantity(existingItem);
			const additionalQuantity = foundry.utils.getProperty(itemData, 'system.quantity');
			if (currentQuantity === null || additionalQuantity === undefined) {
				toCreate.push(itemData);
				continue;
			}
			const pendingQuantity = updateQuantities.get(existingItem.id) ?? currentQuantity;
			updateQuantities.set(existingItem.id, pendingQuantity + additionalQuantity);
		}
	}

	const toUpdate = Array.from(updateQuantities, ([id, quantity]) => ({
		_id: id,
		'system.quantity': quantity,
	}));
	const updated = toUpdate.length ? await actor.updateEmbeddedDocuments('Item', toUpdate) : [];
	const created = toCreate.length ? await actor.createEmbeddedDocuments('Item', toCreate) : [];
	return [...updated, ...created];
}

async function postHarvestSkillPrompt(payload, options = {}) {
	const context = await hydrateHarvestPayload(payload);
	if (!context) return;

	const { actor, targetActor, table } = context;
	const { entries: available, skipped } = await resolveTableHarvestResults(table);
	const harvestedBySkill = getHarvestedBySkill(targetActor, table.uuid);
	debugLog(`${DEBUG_PREFIX} postHarvestSkillPrompt:context`, {
		actor: actor?.name,
		targetActor: targetActor.name,
		table: table?.name,
		tableUuid: table?.uuid,
		availableEntries: available.length,
		harvestedBySkill,
	});
	const skillStats = new Map();
	for (const entry of available) {
		const harvested = harvestedBySkill[entry.skill] ?? [];
		if (harvested.includes(entry.result.id)) continue;
		const existing = skillStats.get(entry.skill) ?? { count: 0, minDc: Number.POSITIVE_INFINITY, maxDc: 0 };
		existing.count += 1;
		existing.minDc = Math.min(existing.minDc, entry.dc);
		existing.maxDc = Math.max(existing.maxDc, entry.dc);
		skillStats.set(entry.skill, existing);
	}
	const requesterId = payload?.requesterUserId ?? game.user.id;
	const gmIds = getGmUserIds();
	const requesterUser = requesterId ? game.users.get(requesterId) : null;
	const requesterIsGm = requesterUser?.isGM;
	const requesterIsActiveGm = requesterUser?.isActiveGM;
	const activeGmId = game.users.find((user) => user.isActiveGM)?.id;
	const requesterIds = requesterId ? [requesterId] : [];
	let gmRecipientIds = [];
	if (requesterIsActiveGm) {
		gmRecipientIds = [];
	} else if (requesterIsGm) {
		gmRecipientIds = activeGmId ? [activeGmId] : gmIds.filter((id) => id !== requesterId).slice(0, 1);
	} else {
		gmRecipientIds = activeGmId ? [activeGmId] : gmIds.slice(0, 1);
	}
	const createRequesterMessage = options.createRequesterMessage ?? true;
	const createGmMessage = options.createGmMessage ?? true;
	const canCreateGmMessageLocally = game.user.isGM && createGmMessage;

	if (!skillStats.size) {
		if (available.length === 0 && skipped.missingSkillOrDc > 0) {
			const missingBits = [];
			if (skipped.missingSkill > 0) missingBits.push(`${localize('BBH.WARN.MissingSkillLabel')} (${skipped.missingSkill})`);
			if (skipped.missingDc > 0) missingBits.push(`${localize('BBH.WARN.MissingDcLabel')} (${skipped.missingDc})`);
			const details = missingBits.join(', ');
			const message = format('BBH.WARN.HarvestTableMissingResultConfig', {
				tableName: table.name,
				details,
			});
			console.warn(`${DEBUG_PREFIX} ${message}`);
			ui.notifications.info(message);
		}
		console.info(
			`${DEBUG_PREFIX} ${JSON.stringify({
				event: 'postHarvestSkillPrompt:no-harvestable-results',
				table: table?.name ?? null,
				tableUuid: table?.uuid ?? null,
				availableEntries: available.length,
				harvestedBySkill,
			})}`,
		);
		infoLog(`${DEBUG_PREFIX} postHarvestSkillPrompt:no-harvestable-results`, {
			table: table?.name,
			tableUuid: table?.uuid,
			availableEntries: available.length,
			reason: available.length ? 'all-filtered-by-harvested-state' : 'no-valid-entries-after-skill-dc-item-filters',
		});
		ui.notifications.info(localize('BBH.WARN.NoHarvestableResultsRemaining'));
		if (createRequesterMessage && requesterIds.length) {
			await ChatMessage.create({
				speaker: ChatMessage.getSpeaker({ actor }),
				content: `
      <div class="bugbears-harvester-chat-card">
        <h3>${localize('BBH.CHAT.HarvestAttemptTitle')}</h3>
        <p>${format('BBH.CHAT.AttemptBody', {
					actorName: `<strong>${foundry.utils.escapeHTML(actor.name)}</strong>`,
					targetName: `<strong>${foundry.utils.escapeHTML(targetActor.name)}</strong>`,
				})}</p>
        <p>${format('BBH.CHAT.TableLine', { tableName: foundry.utils.escapeHTML(table.name) })}</p>
        <p>${foundry.utils.escapeHTML(localize('BBH.WARN.NoHarvestableResultsRemaining'))}</p>
      </div>
    `,
				whisper: requesterIds,
			});
		}

		if (canCreateGmMessageLocally && gmRecipientIds.length) {
			await ChatMessage.create({
				speaker: ChatMessage.getSpeaker({ actor }),
				content: `
          <div class="bugbears-harvester-chat-card">
            <h3>${localize('BBH.CHAT.HarvestAttemptTitle')}</h3>
            <p>${format('BBH.CHAT.AttemptBody', {
							actorName: `<strong>${foundry.utils.escapeHTML(actor.name)}</strong>`,
							targetName: `<strong>${foundry.utils.escapeHTML(targetActor.name)}</strong>`,
						})}</p>
            <p>${format('BBH.CHAT.TableLine', { tableName: foundry.utils.escapeHTML(table.name) })}</p>
            <p>${foundry.utils.escapeHTML(localize('BBH.WARN.NoHarvestableResultsRemaining'))}</p>
          </div>
        `,
				whisper: gmRecipientIds,
			});
		}
		return;
	}

	const buttonsForUser = [];
	const buttonsForGm = [];
	for (const [skill, stat] of skillStats.entries()) {
		const skillLabel = localize(CONFIG.DND5E.skills?.[skill]?.label ?? skill);
		const dcRangeLabel = stat.minDc === stat.maxDc ? `${stat.minDc}` : `${stat.minDc}-${stat.maxDc}`;
		buttonsForUser.push(`
      <button type="button" data-harvester-action="roll-skill" data-harvester-skill="${foundry.utils.escapeHTML(skill)}">
        ${foundry.utils.escapeHTML(skillLabel)}
      </button>
    `);
		buttonsForGm.push(`
      <button type="button" data-harvester-action="roll-skill" data-harvester-skill="${foundry.utils.escapeHTML(skill)}">
        ${foundry.utils.escapeHTML(skillLabel)} (DC ${dcRangeLabel}, ${stat.count})
      </button>
    `);
	}

	if (createRequesterMessage && requesterIds.length) {
		const requesterButtons = requesterIsActiveGm ? buttonsForGm : buttonsForUser;
		const requesterTableLine = requesterIsActiveGm ? `<p>${format('BBH.CHAT.TableLine', { tableName: foundry.utils.escapeHTML(table.name) })}</p>` : '';
		await ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content: `
      <div class="bugbears-harvester-chat-card">
        <h3>${localize('BBH.CHAT.HarvestAttemptTitle')}</h3>
        <p>${format('BBH.CHAT.AttemptBody', {
					actorName: `<strong>${foundry.utils.escapeHTML(actor.name)}</strong>`,
					targetName: `<strong>${foundry.utils.escapeHTML(targetActor.name)}</strong>`,
				})}</p>
        ${requesterTableLine}
        <p>${localize('BBH.CHAT.SelectSkillPrompt')}</p>
        <div class="bugbears-harvester-chat-actions">${requesterButtons.join('')}</div>
      </div>
    `,
			flags: {
				[MODULE_ID]: {
					pendingHarvest: payload,
				},
			},
			whisper: requesterIds,
		});
	}

	if (canCreateGmMessageLocally && gmRecipientIds.length) {
		await ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content: `
        <div class="bugbears-harvester-chat-card">
          <h3>${localize('BBH.CHAT.HarvestAttemptTitle')}</h3>
          <p>${format('BBH.CHAT.AttemptBody', {
						actorName: `<strong>${foundry.utils.escapeHTML(actor.name)}</strong>`,
						targetName: `<strong>${foundry.utils.escapeHTML(targetActor.name)}</strong>`,
					})}</p>
          <p>${format('BBH.CHAT.TableLine', { tableName: foundry.utils.escapeHTML(table.name) })}</p>
          <p>${localize('BBH.CHAT.SelectSkillPrompt')}</p>
          <div class="bugbears-harvester-chat-actions">${buttonsForGm.join('')}</div>
        </div>
      `,
			flags: {
				[MODULE_ID]: {
					pendingHarvest: payload,
				},
			},
			whisper: gmRecipientIds,
		});
	}

	if (!game.user.isGM && createGmMessage && gmRecipientIds.length) {
		await requestGmPostHarvestPrompt(payload);
	}
}

function buildHarvestOutcomeContent({ actor, targetActor, creatureType, table, skill, total, successCount, rewards, showTableLine = false }) {
	const skillLabel = localize(CONFIG.DND5E.skills?.[skill]?.label ?? skill);
	const success = successCount > 0;
	const successTitle = success ? localize('BBH.CHAT.HarvestSucceeded') : localize('BBH.CHAT.HarvestFailed');
	const rewardLabel =
		success ?
			foundry.utils.escapeHTML(rewards.map((reward) => `${Math.max(1, Math.floor(typeof reward.quantity === 'number' ? reward.quantity : 1))} x ${reward.itemName} (DC ${reward.dc})`).join(', '))
		:	localize('BBH.COMMON.None');
	const tableLine = showTableLine ? `<p>${format('BBH.CHAT.TableLine', { tableName: foundry.utils.escapeHTML(table.name) })}</p>` : '';
	return `
      <div class="bugbears-harvester-chat-card">
        <h3>${successTitle}</h3>
        <p>${format('BBH.CHAT.OutcomeBody', {
					actorName: `<strong>${foundry.utils.escapeHTML(actor.name)}</strong>`,
					targetName: `<strong>${foundry.utils.escapeHTML(targetActor.name)}</strong>`,
					creatureType: foundry.utils.escapeHTML(creatureType),
				})}</p>
        ${tableLine}
        <p>${format('BBH.CHAT.CheckResultLine', { skillLabel: foundry.utils.escapeHTML(skillLabel), total })}</p>
        <p>${format('BBH.CHAT.RewardLine', { rewardName: rewardLabel })}</p>
      </div>
    `;
}

function getHarvestedBySkill(targetActor, tableUuid) {
	const flag = targetActor.getFlag(MODULE_ID, FLAGS.actor.harvestedResults) ?? {};
	const byTable = getHarvestedByTableUuid(flag, tableUuid);
	if (!byTable || typeof byTable !== 'object') return {};
	return byTable;
}

function getHarvestedResultIds(targetActor, tableUuid, skill) {
	const bySkill = getHarvestedBySkill(targetActor, tableUuid);
	return new Set(bySkill?.[skill] ?? []);
}

async function markHarvestedResults(targetActor, tableUuid, skill, resultIds) {
	if (!resultIds.length) return;
	const flag = foundry.utils.deepClone(targetActor.getFlag(MODULE_ID, FLAGS.actor.harvestedResults) ?? {});
	const existingByTable = getHarvestedByTableUuid(flag, tableUuid);
	const byTable = existingByTable && typeof existingByTable === 'object' ? existingByTable : {};
	const current = new Set(byTable[skill] ?? []);
	for (const resultId of resultIds) current.add(resultId);
	byTable[skill] = [...current];
	setHarvestedByTableUuid(flag, tableUuid, byTable);
	await targetActor.setFlag(MODULE_ID, FLAGS.actor.harvestedResults, flag);
}

async function requestGmMarkHarvestedResults({ targetActorUuid, tableUuid, skill, resultIds }) {
	if (!targetActorUuid || !tableUuid || !skill || !resultIds?.length) return;
	const gm = game.users.activeGM;
	if (!gm) return;
	try {
		await gm.query(QUERY_MARK, {
			request: {
				targetActorUuid,
				tableUuid,
				skill,
				resultIds: [...new Set(resultIds)],
			},
		});
	} catch (error) {
		console.warn(`${DEBUG_PREFIX} requestGmMarkHarvestedResults:query-failed`, error);
	}
}

async function requestGmPostHarvestPrompt(payload) {
	const gm = game.users.activeGM;
	if (!gm) return;
	try {
		await gm.query(QUERY_PROMPT, { payload });
	} catch (error) {
		console.warn(`${DEBUG_PREFIX} requestGmPostHarvestPrompt:query-failed`, error);
	}
}

async function requestGmIncrementHarvestAttempts(targetActorUuid) {
	if (!targetActorUuid) return;
	const gm = game.users.activeGM;
	if (!gm) return;
	try {
		await gm.query(QUERY_MARK, {
			request: {
				targetActorUuid,
				incrementAttempts: true,
			},
		});
	} catch (error) {
		console.warn(`${DEBUG_PREFIX} requestGmIncrementHarvestAttempts:query-failed`, error);
	}
}

async function applyHarvestMarkRequest(request) {
	if (!request) return;
	const { targetActorUuid, tableUuid, skill, resultIds, incrementAttempts } = request;
	if (!targetActorUuid) return;

	const targetActor = await fromUuid(targetActorUuid).catch(() => null);
	if (!(targetActor instanceof Actor)) return;
	if (incrementAttempts) {
		await incrementHarvestAttempts(targetActor);
		return;
	}
	if (!tableUuid || !skill || !Array.isArray(resultIds) || !resultIds.length) return;
	const uniqueResultIds = [...new Set(resultIds)];
	await markHarvestedResults(targetActor, tableUuid, skill, uniqueResultIds);
}

function isItemDocument(document) {
	if (!document) return false;
	if (document instanceof Item) return true;
	return document.documentName === 'Item';
}

function isHarvestableTargetActor(targetActor) {
	const hpValue = targetActor.system?.attributes?.hp?.value;
	return hpValue <= 0;
}

function hasReachedHarvestAttemptLimit(targetActor) {
	const attempts = getHarvestAttempts(targetActor);
	const maxAttempts = getHarvestAttemptsMaxForActor(targetActor);
	return attempts >= maxAttempts;
}

function getHarvestAttempts(actor) {
	const value = actor.getFlag(MODULE_ID, FLAGS.actor.harvestAttempts);
	if (value === undefined || value === null || value === '') return 0;
	const attempts = Math.floor(value);
	return attempts >= 0 ? attempts : 0;
}

async function incrementHarvestAttempts(actor) {
	const nextAttempts = getHarvestAttempts(actor) + 1;
	await actor.setFlag(MODULE_ID, FLAGS.actor.harvestAttempts, nextAttempts);
}

function getHarvestAttemptsReachedMessage(actor) {
	const maxAttempts = getHarvestAttemptsMaxForActor(actor);
	return format('BBH.WARN.HarvestAttemptsReached', {
		targetName: actor.name,
		maxAttempts,
	});
}

async function resetHarvestedResultsForSelection() {
	const controlledActors = canvas.tokens.controlled.map((token) => token.actor).filter(Boolean);
	const targetedActors = Array.from(game.user.targets ?? [])
		.map((token) => token?.actor)
		.filter(Boolean);
	const actorsByUuid = new Map();
	for (const actor of [...controlledActors, ...targetedActors]) {
		if (actor?.uuid) actorsByUuid.set(actor.uuid, actor);
	}
	const actors = [...actorsByUuid.values()];
	if (!actors.length) {
		ui.notifications.warn(localize('BBH.WARN.SelectTargetsOrControlledForReset'));
		return;
	}

	let resetCount = 0;
	for (const actor of actors) {
		const current = actor.getFlag(MODULE_ID, FLAGS.actor.harvestedResults);
		const attempts = actor.getFlag(MODULE_ID, FLAGS.actor.harvestAttempts);
		if (current === undefined && attempts === undefined) continue;
		if (current !== undefined) await actor.unsetFlag(MODULE_ID, FLAGS.actor.harvestedResults);
		if (attempts !== undefined) await actor.unsetFlag(MODULE_ID, FLAGS.actor.harvestAttempts);
		resetCount += 1;
	}

	ui.notifications.info(format('BBH.INFO.ResetHarvestedResultsDone', { count: resetCount, total: actors.length }));
}

function getHarvestedByTableUuid(flagData, tableUuid) {
	if (!flagData || typeof flagData !== 'object') return null;
	const direct = flagData?.[tableUuid];
	if (direct && typeof direct === 'object') return direct;
	const nested = foundry.utils.getProperty(flagData, tableUuid);
	if (nested && typeof nested === 'object') return nested;
	return null;
}

function setHarvestedByTableUuid(flagData, tableUuid, value) {
	if (!flagData || typeof flagData !== 'object') return;
	if (Object.prototype.hasOwnProperty.call(flagData, tableUuid)) {
		flagData[tableUuid] = value;
		return;
	}
	foundry.utils.setProperty(flagData, tableUuid, value);
}
