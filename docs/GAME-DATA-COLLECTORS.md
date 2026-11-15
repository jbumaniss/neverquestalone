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
   end)
   ```

4. Test supported values, unavailable APIs and restricted/secret values using `tests/helpers/nqa-vm.js`.

Collectors execute in ascending priority; ties sort by name. Duplicate names are rejected. One failing collector does not prevent subsequent collectors or the quest log from being gathered. The original collectors retain priorities 10–70 and ordering. Optional lines at the end may be omitted by the 900-byte context limit. A collector must not write to the game, use protected actions or assume a third-party addon exists.

## Next capability families

- Bag item counts / inventory: a bounded, explicit-on-request report; avoid sending full bags on every message.
- Learned abilities and cooldowns: version-specific read-only APIs, only the subset relevant to a question.
- Reputation, groups and combat: separate collectors with privacy and combat/secret-value guards.
- Auctionator and Questie: reuse the existing optional integration adapters; distinguish unavailable data from zero values.
- Equipment names and stats: existing `ItemContext.lua` already expands linked item tooltips; validate cached item availability before adding bulk descriptions.

For larger fields, design a separate versioned, bounded on-demand message and bridge validator with explicit permission, rather than silently increasing `CONTEXT_MAX` or the companion-state limits. Keep each API family, validator and test independent.
