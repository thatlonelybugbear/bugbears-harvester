import { MODULE_ID } from './bbh-constants.mjs';
import { debugLog } from './bbh-utils.mjs';

Hooks.once('ready', async function () {
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

	const MODULE_ID = 'bbh';

	// Store latest rolled table
	let lastRolledTable = null;

	// Store rerolled quantities by item name
	const quantityMap = new Map();

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

					const tableResult = lastRolledTable.results.contents.find((r) => {
						if (r.text === itemName) return true;

						return r.text?.trim() === itemName;
                    });
                    
					debugLog(`${MODULE_ID} | Found table result:`, tableResult);
					if (!tableResult) continue;

					debugLog(`${MODULE_ID} | Processing rolled item:`, itemName, tableResult);

					const itemUuid = tableResult.documentUuid;
					const itemHasBbhQuantityFormula = tableResult.flags?.[MODULE_ID]?.quantity;

					if (!itemHasBbhQuantityFormula) continue;

					const roll = await new Roll(`${itemHasBbhQuantityFormula}`).evaluate();

					const quantity = Math.max(1, roll.total);

					const input = row.querySelector('input.item-piles-quantity');

					if (!input) continue;

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
