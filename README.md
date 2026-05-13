# Bugbear's Harvester (BBH)

A reincarnation of a classic Foundry VTT module for D&D 5e that lets you configure harvesting roll tables per creature type, roll a harvest skill check targeting your fallen prey, and automatically award harvested items (with quantity support) to your actor.

## Compatibility

- Foundry VTT v13 (v14 should be available in a few days)
- D&D 5E system v5+ (verified for 5.3.3).

## Quick Start

1. As GM, open the BBH controls (scissors icon) on the left.
2. Click `Configure Tables` and map creature types to your harvest RollTables (drag a RollTable into the UUID field).
3. Open one of those RollTables:
   - Harvest Data is auto-enabled by BBH for mapped tables.
   - Quantity Data is optional and user-controlled in the BBH RollTable sheet.
   - For each table entry, link an Item document and set the harvest skill/DC (and quantity if enabled).
4. Then players or the GM can:
   - Select a token they have permission or default to their assigned character actor.
   - Target exactly one token that is at `0 HP`.
   - Click `Harvest Target` and follow the chat prompt.

## How Harvest Resolution Works

- BBH resolves the targeted creature's type from `target.actor.system.details.type` trying to match per value, subtype and custom entries.
- It picks the first configured RollTable for that creature type/subtype/custom (or `ALL`).
- You choose a harvest skill (from those present on the table results).
- BBH rolls that skill for the harvesting actor (auto-fast-forward is configurable).
- **For each** table entry matching the chosen skill:
  - If the roll total meets/exceeds the entry's DC, BBH creates the linked Item on the harvesting actor.
  - If a quantity formula is present, it is rolled and applied as `system.quantity` (minimum 1).
- Each harvest check increments `targetActor.flags.bbh.harvestAttempts`.
  - BBH blocks further checks when attempts reach the configured max for that creature size.
  - You can override per actor with `actor.flags.bbh.harvestMaxOverride` (number >= 1).
- Successfully harvested result ids are recorded on the target actor to prevent repeating the same result for that table+skill.
  - If the harvester is not a GM, BBH requests the active GM to apply the harvested-result marks.

## Quantity Support (RollTables + Drag & Drop)

- If "Quantity Data" is enabled on a RollTable, each result can define a quantity formula.
- BBH does not auto-enable Quantity Data when mapping tables; users toggle it per table.
- When that RollTable is drawn normally (via "Roll"), BBH appends quantity info into the resulting chat card.
  - When you drag a result item from chat onto an actor sheet, BBH applies the rolled quantity.
  - If the dropped item (and an existing actor item) share the same `system.identifier`, BBH updates the existing item quantity instead of creating a duplicate.

## Settings

- `Fast Forward Harvest Checks` (default: `off`): Skip the roll configuration dialog for harvest checks.
- `Auto-Enable Quantity Data on New RollTables` (default: `off`): If enabled, new RollTables start with Quantity Data enabled by default.
- `Preferred RollTable Compendium`: GM-only fallback compendium source used by the creature-type table mapping UI.
- `Max Harvest Attempts by Size`: Opens a menu to configure world values per D&D5e actor size; defaults to `CONFIG.DND5E.actorSizes[<size>].numerical` (minimum 1).
- `Debug Logging`: A hidden world setting, which enables BBH debug/info logs in the browser console. Toggle via: `await game.settings.set('bbh', 'debug', !game.settings.get('bbh', 'debug'));`

Additional hidden settings are used to store creature-type mappings, per-size max-harvest-attempt values, and a last-opened RollTable pointer for UI quality-of-life.

## UI / Controls

- Token controls:
  - `Harvest Target`: Run harvesting for the selected/open actor against your single targeted token.
  - `Reset Harvested Results` (GM): Clear BBH harvested-result flags on selected and/or targeted actors.
  - `Configure Tables` (GM): Open the creature-type table mapping menu.
- Document sheets:
  - BBH registers custom RollTable and TableResult sheets and (for GMs) sets them as defaults so harvest fields are visible while editing tables.

## What you can do

- Configure a mapping of `creature type -> RollTable`.
  - Available creatures types are all the entries in `CONFIG.DND5E.creatureTypes`
  - Default entry is an `ALL` entry which essentially uses on table to roll no matter the creature type.
  - You can also add multiple `CUSTOM` entries, to specify more granural control over subtypes of creatures, using strings like `dragon: red, silver` which would match any `Dragon (Red)` or `Dragon (Silver)` entries, but not a generic `Dragon` or `Dragon (Gold)` entries.
- Mark RollTables as "harvest tables" and expose per-result harvest fields:
  - Harvest skill
  - Harvest DC
  - Reward quantity (fixed number or roll formula like `1d4`)
- Add a token control button to run harvesting against your single targeted token.
- Post a chat prompt to pick which harvest skill to attempt, then roll the check and award items for all results of that skill that succeed.
- Prevent repeat harvesting of the same table results for the same target via flags; includes a GM action to reset harvested results.
- Append quantity info to normal RollTable chat messages (useful when actual rolling on harvest tables).
  - Compendium RollTables are also supported: BBH resolves the table asynchronously in `createChatMessage` when the table is not in `game.tables`.
- Improve actor-sheet drag/drop:
  - If you drag a harvest-result item onto an actor sheet, the created item will have the rolled quantity applied.
  - If the actor already has an item with the same `system.identifier`, the drop aggregates quantity instead of creating duplicates.

## What you must do

- Harvesting requires exactly one targeted token and the target must be at `0 HP` or below, have a valid associated world actor and be a creature.
- Harvest RollTables must have results that are linked to Item documents and include harvest skill + DC.
  - Roll table entries without a Skill or DC set will be ignored from the Harvest Target function.
  - If no usable results exist because result Skill/DC config is missing, BBH shows a targeted info message and `console.warn`.
- Identifier-based drag/drop aggregation relies on `item.system.identifier` being populated consistently.

## API

BBH exposes a small module API which I might expand in the future.

```js
game.modules.get('bbh')?.api?.runHarvest({ actor, target });
```

- If `actor` is omitted, BBH tries to resolve the "harvesting actor" from your current controlled token.
- `target` can be a `Token`, `TokenDocument` or `Actor` instance, but if omitted BBH will try to resolve a single targeted token and use its actor as the target.

## Bug Reports

- <https://github.com/thatlonelybugbear/bugbears-harvester/issues>
