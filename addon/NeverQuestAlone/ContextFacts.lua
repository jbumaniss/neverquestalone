-- Common, read-only helpers for separately loaded on-question data capabilities.
local _, ns = ...
local F = {}
ns.ContextFacts = F

function F.Relevant(words)
	return function(q)
		for _, word in ipairs(words) do
			if q:find(word, 1, true) then return true end
		end
		return false
	end
end

function F.Number(Try, fn, ...)
	local v = ns.Readable(Try(fn, ...))
	if type(v) == "number" and v == v and v >= 0 then return v end
end

function F.Text(v, max)
	v = ns.Readable(v)
	if type(v) ~= "string" or v == "" then return nil end
	return ns.Utf8Cut(ns.CleanField(v), max or 48)
end

function F.Add(lines, label, details)
	if #details == 0 then return end
	-- Bound each optional feature independently; a complete quest list still
	-- has first claim on the total context budget.
	local result, used = {}, 0
	for _, detail in ipairs(details) do
		local safe = F.Text(detail, 120)
		if safe and used + #safe + (#result > 0 and 2 or 0) <= 280 then
			result[#result + 1] = safe
			used = used + #safe + (#result > 1 and 2 or 0)
		else break end
	end
	if #result > 0 then lines[#lines + 1] = label .. ": " .. table.concat(result, ", ") end
end
