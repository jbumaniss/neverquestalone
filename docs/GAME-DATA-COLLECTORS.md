# Game-data collectors

The addon has two distinct ways to provide facts to the AI:

- **Text context** (`GameContext.lua`, 900-byte budget): concise live facts sent with a message. The complete quest-ID line, when present, is reserved outside the optional lines.
- **Companion state** (`Companion.lua`, versioned JSON with explicit size limits and an `omitted` list): quests, objectives, equipment IDs/levels, professions, route markers and milestones. It is not an unlimited transport for new fields.

An absent field in an AI snapshot means **not received**. It never proves that the game or addon cannot supply the field. The player/target health, power and name collector added here only affects **text context**; it is not yet a new companion-state field.

## Adding a live context collector

1. Put its read-only game API calls in a new Lua module. Do not change `Chats.lua` or the companion serializer for text-only facts.
2. Add the module to `NeverQuestAlone.toc` **after** `GameContext.lua` and **before** `Chats.lua`.
3. Register a unique name and numeric priority:

   ```lua
   ns.GameContext.Register("example", 45, function(lines, Try)
       local value = ns.Readable(Try(SomeGameAPI, "player"))
       if type(value) == "number" then
           lines[#lines + 1] = "Example: " .. value
       end
   end, ns.ContextFacts.Relevant({ "example", "related question" }))
   ```

4. Test supported values, unavailable APIs and restricted/secret values using `tests/helpers/nqa-vm.js`.

Collectors execute in ascending priority; ties sort by name. Duplicate names are rejected. One failing collector does not prevent subsequent collectors or the quest log from being gathered. The original collectors retain priorities 10–70 and ordering. Relevant-question collectors run only when their match function returns true. Optional lines may be omitted by the 900-byte context limit. A collector must not write to the game, use protected actions or assume a third-party addon exists.

Currently implemented question-triggered modules:

- `InventoryContext`: bag IDs, counts and cached names (at most 10 types shown).
- `AbilitiesContext`: a spellbook summary, active cooldowns and spent talent ranks.
- `ReputationContext`: known faction standings.
- `GroupCombatContext`: group composition without other players' names, buffs and debuffs.
- `EquipmentContext`: worn item IDs, names, item levels and optional stats.
- `MovementContext`: speed, facing and travel state when readable.
- `ServicesContext`: bounded item summaries, mail subjects and merchant prices from *currently open* interfaces; no remote access.
- `CollectionsContext`: supported mount/pet/achievement counts.
- `AuctionContext`: a locally indexed Auctionator price for a question naming an item ID.

None of these modules automate gameplay. A missing line means the collector was not triggered, the API returned no usable data, or the byte budget excluded it; it never means the character has zero items/abilities/reputation.

## Remaining transport limitations

- Large inventories and complete spellbooks require chunked, versioned transport when the question needs more than the 900-byte context.
- A journal or add-on feature absent in the installed client has no replacement or inferred zero value.
- Auctionator price lookup currently requires an item ID; it is not a live auction search.
- Persistent memory and speech playback are desktop features and must be verified separately from addon collectors.

For larger fields, design a separate versioned, bounded on-demand message and bridge validator with explicit permission, rather than silently increasing `CONTEXT_MAX` or the companion-state limits. Keep each API family, validator and test independent.
