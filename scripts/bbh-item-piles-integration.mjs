import { MODULE_ID } from './bbh-constants.mjs';
import { debugLog } from './bbh-utils.mjs';

Hooks.once('ready', async function () {
	if (!game.modules.get('item-piles')?.active) return;

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
	// 6. Syncs quantities through the merchant's bound quantity inputs
	//
	// ======================================================

	// Store latest rolled table
	let lastRolledTable = null;

	// ======================================================
	// CLICK INTERCEPT
	// ======================================================

	document.addEventListener(
		'click',
		(event) => {
			const button = event.target.closest('.item-piles-rolled-item-button[data-fast-tooltip]');
			if (button?.dataset.fastTooltip !== game.i18n.localize('ITEM-PILES.Merchant.TooltipRollTable')) return;
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
					const addButton = row.querySelector('.item-piles-rolled-item-button[data-fast-tooltip]');
					if (addButton?.dataset.fastTooltip !== game.i18n.localize('ITEM-PILES.Merchant.AddItem')) continue;
					const itemName = row.querySelector('.item-piles-clickable')?.textContent?.trim();
					debugLog(`${MODULE_ID} | Processing rolled item:`, itemName);
					if (!itemName) continue;

					// Skip already processed rows
					if (row.dataset.quantityProcessed) continue;

					const tableResult = lastRolledTable.results.contents.find((r) => {
						if (r.name === itemName) return true;

						return r.name?.trim() === itemName;
					});

					debugLog(`${MODULE_ID} | Found table result:`, tableResult);
					if (!tableResult) continue;

					debugLog(`${MODULE_ID} | Processing rolled item:`, itemName, tableResult);

					const itemHasBbhQuantityFormula = tableResult.flags?.[MODULE_ID]?.quantity;

					if (!itemHasBbhQuantityFormula) continue;

					row.dataset.quantityProcessed = 'true';
					const roll = await new Roll(`${itemHasBbhQuantityFormula}`).evaluate({ allowInteractive: false });

					const quantity = Math.max(1, roll.total);

					const input = row.querySelector('input.item-piles-quantity');

					if (!input) continue;

					input.value = quantity;

					input.dispatchEvent(new Event('input', { bubbles: true }));

					input.dispatchEvent(new Event('change', { bubbles: true }));

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

});
