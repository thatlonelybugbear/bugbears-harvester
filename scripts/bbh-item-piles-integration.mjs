import { FLAGS, MODULE_ID } from './bbh-constants.mjs';
import { debugLog } from './bbh-utils.mjs';

Hooks.once('ready', async function () {
	if (!(game.modules.get('item-piles') && game.modules.get('itempilesdnd5e'))) return;

	if (window.bbhQuantityRerollerInitialized) return;

	window.bbhQuantityRerollerInitialized = true;

	// ======================================================
	// ITEM PILES - CUSTOM QUANTITY REROLLER
	// ======================================================
	//
	// What this does:
	//
	// 1. Detects when an Item Piles Merchant Roll Table
	// button is clicked
	// 2. Tracks which RollTable generated items
	// 3. Watches Item Piles for newly rendered rolled items
	// 4. Reads custom quantity formulas from item flags
	// 5. Updates the quantity inputs in the DOM
	// 6. Syncs those DOM quantities back into Item Piles
	//    during item-piles-preAddItems
	//
	// ======================================================

	// Store latest rolled table
	let lastRolledTable = null;
	let lastRolledResults = [];

	// Store rerolled quantities by item name
	const quantityMap = new Map();

	if (!RollTable.prototype._bbhItemPilesRollPatched) {
		const originalRoll = RollTable.prototype.roll;
		RollTable.prototype.roll = async function bbhItemPilesRoll(options = {}) {
			const draw = await originalRoll.call(this, options);
			if (this === lastRolledTable && (options?._depth ?? 0) === 0) lastRolledResults = Array.isArray(draw?.results) ? draw.results : [];
			return draw;
		};
		RollTable.prototype._bbhItemPilesRollPatched = true;
	}

	// ======================================================
	// CLICK INTERCEPT
	// ======================================================

	document.addEventListener(
		'click',
		(event) => {
			const button = event.target.closest('.item-piles-rolled-item-button[data-fast-tooltip="Roll Table"]');
			if (!button) return;

			const container = button.closest('.item-piles-flexrow');
			const tableName = container?.querySelector('strong')?.textContent?.trim();

			if (!tableName) return;

			const table = game.tables.getName(tableName);

			if (!table) return;

			lastRolledTable = table;
			lastRolledResults = [];

			debugLog(`${MODULE_ID} | Rolling table:`, table.name);
		},
		true,
	);

	// ======================================================
	// CLEAN UP OLD OBSERVER
	// ======================================================

	window.customQuantityObserver?.disconnect();

	// ======================================================
	// MUTATION OBSERVER
	// ======================================================

	window.customQuantityObserver = new MutationObserver(async (mutations) => {
		if (!lastRolledTable) return;

		for (const mutation of mutations) {
			for (const node of mutation.addedNodes) {
				if (!(node instanceof HTMLElement)) continue;

				const rows = node.matches?.('.item-piles-flexrow.item-piles-item-row') ? [node] : [...(node.querySelectorAll?.('.item-piles-flexrow.item-piles-item-row') ?? [])];

				for (const row of rows) {
					const itemName = row.querySelector('.item-piles-clickable')?.textContent?.trim();
					debugLog(`${MODULE_ID} | Processing rolled item:`, itemName);
					if (!itemName) continue;

					// Skip already processed rows
					if (row.dataset.quantityProcessed) continue;

					const candidateResults = lastRolledResults.length ? lastRolledResults : await collectNestedTableResults(lastRolledTable);
					const tableResult = candidateResults.find((r) => {
						if (r.name?.trim() === itemName) return true;
						if (r.text === itemName) return true;

						return r.text?.trim() === itemName;
					});

					debugLog(`${MODULE_ID} | Found table result:`, tableResult);
					if (!tableResult) continue;

					debugLog(`${MODULE_ID} | Processing rolled item:`, itemName, tableResult);

					const itemHasBbhQuantityFormula = tableResult.getFlag?.(MODULE_ID, FLAGS.result.quantity) ?? tableResult.flags?.[MODULE_ID]?.quantity;

					if (!itemHasBbhQuantityFormula) continue;

					const roll = await new Roll(`${itemHasBbhQuantityFormula}`).evaluate();

					const bbhQuantity = Math.max(1, Math.floor(roll.total));

					const input = row.querySelector('input.item-piles-quantity');

					if (!input) continue;

					const ipQuantity = Math.max(1, Math.floor(Number.parseFloat(input.value) || 1));
					const quantity = ipQuantity * bbhQuantity;

					input.value = quantity;

					input.dispatchEvent(new Event('input', { bubbles: true }));

					input.dispatchEvent(new Event('change', { bubbles: true }));

					// Store for hook sync
					quantityMap.set(itemName, quantity);

					// Prevent duplicate processing
					row.dataset.quantityProcessed = 'true';

					debugLog(`${MODULE_ID} | ${itemName} => ${quantity}`);
				}
			}
		}
	});

	// ======================================================
	// START OBSERVING
	// ======================================================

	window.customQuantityObserver.observe(document.body, {
		childList: true,
		subtree: true,
	});

	// ======================================================
	// ITEM PILES HOOK
	// ======================================================
	Hooks.on('item-piles-preAddItems', (actor, _, items) => {
		debugLog(`${MODULE_ID} | preAddItems`, actor, items);

		for (const item of items) {
			if (!item) continue;

			const existingItem = actor.items.find((i) => i.name === item.name && i.type === item.type && i.system.identifier === item.system.identifier);
			const existingQuantity = existingItem?.system.quantity ?? 0;

			const quantity = quantityMap.get(item.name);

			if (quantity == null) continue;

			item.system.quantity = quantity + existingQuantity;

			debugLog(`${MODULE_ID} | Synced ${item.name} => ${quantity}`);
		}
	});
});

async function collectNestedTableResults(table, depth = 0, seen = new Set()) {
	if (!(table instanceof RollTable) || depth > 5 || seen.has(table.uuid)) return [];
	seen.add(table.uuid);

	const results = [];
	for (const result of table.results?.contents ?? []) {
		const documentName = foundry.utils.parseUuid(result.documentUuid)?.type;
		if (result.type === 'document' && documentName === 'RollTable') {
			const nestedTable = await fromUuid(result.documentUuid).catch(() => null);
			results.push(...(await collectNestedTableResults(nestedTable, depth + 1, seen)));
		} else {
			results.push(result);
		}
	}
	return results;
}
