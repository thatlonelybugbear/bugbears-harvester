import { MODULE_ID, SETTINGS } from './bbh-constants.mjs';

export function localize(key) {
	return game.i18n.localize(key);
}

export function format(key, data = {}) {
	return game.i18n.format(key, data);
}

export function parseNonNegativeInteger(value) {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return parsed;
}

export function isDebugEnabled() {
	return game.settings.get(MODULE_ID, SETTINGS.debug) === true;
}

export function debugLog(...args) {
	if (!isDebugEnabled()) return;
	console.debug(...args);
}

export function infoLog(...args) {
	if (!isDebugEnabled()) return;
	console.info(...args);
}
