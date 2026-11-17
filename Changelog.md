## 14.611.1
* Prevents creatures from harvesting themselves, including through existing chat prompts.
* Defaults harvest results to Survival when no skill is selected.
* Targets Foundry VTT v14.367+ and retains the D&D 5e v5 minimum. Verified for D&D5e v6.1.1.
* Fixes TableResult range fields and ensures both Harvester document sheets are selected on first setup.
* Uses TableResult names for Item Piles quantity matching.
* Updates Item Piles merchant integration to use localized controls and bound quantities, avoiding global overrides of item additions.
* Stops harvesting when no valid target is selected or the skill roll is cancelled.

## 13.533.4
* Item Piles Merchants and nested Roll Tables now support quantity-enabled rolls, allowing for more dynamic item generation.

## 13.533.3
* Fixed an issue where generic creature mappings (for example `giant`) could be chosen before more specific custom mappings (for example `giant:hill,stone`) during harvesting.
* Harvest table matching now prioritizes the most specific creature type match first.
* Added Italian translation by [GregoryWarn](<https://github.com/GregoryWarn/>) 🤗

## 13.533.2
* Fixes an issue where items with the same identifier but different types would not stack properly when dropped onto an actor.
* Added support for quantity-enabled Roll Tables, being used forItem Piles Merchants Rolls
* Foundry v14 should be supported.

## 13.533.1
* Initial Release
