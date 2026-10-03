#!/usr/bin/env python3
"""Render source-linked report facts; no network, source rewriting or semantic certification."""
import argparse
import json
from pathlib import Path
import sys

MAX_BYTES = 2 * 1024 * 1024
KINDS = {"outcome", "decision", "action", "condition", "evidence"}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def text(value):
    return isinstance(value, str) and bool(value.strip())


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def read_json(path):
    with Path(path).open("rb") as handle:
        data = handle.read(MAX_BYTES + 1)
    require(len(data) <= MAX_BYTES, "Input exceeds 2 MiB")
    return json.loads(data.decode("utf-8"), object_pairs_hook=unique_object)


def render(plan):
    require(isinstance(plan, dict) and type(plan.get("version")) is int and plan["version"] == 1, "Expected plan version 1")
    sources = plan.get("sources")
    require(isinstance(sources, dict), "Sources must map IDs to complete records")
    for key, value in sources.items():
        require(text(key) and isinstance(value, dict) and isinstance(value.get("text"), str), "Invalid source text")
        require(type(value.get("order")) is int and value["order"] >= 0, "Source order must be a nonnegative integer")
    rows = plan.get("facts")
    selected = plan.get("include")
    require(isinstance(rows, list) and len(rows) <= 256, "Expected at most 256 facts")
    require(isinstance(selected, list) and all(text(x) for x in selected) and len(set(selected)) == len(selected), "Expected unique selected fact IDs")
    facts = {}
    for fact in rows:
        require(isinstance(fact, dict), "Fact must be an object")
        require(all(text(fact.get(k)) for k in ("id", "topic", "key", "scope", "kind", "clause")), "Fact has missing text fields")
        require(fact["id"] not in facts and fact["kind"] in KINDS, "Duplicate ID or invalid fact kind")
        require("\n" not in fact["clause"] and "\r" not in fact["clause"], "Fact clause must be one atomic line")
        require(type(fact.get("known", False)) is bool, "known must be boolean")
        ref = fact.get("source")
        require(isinstance(ref, dict) and text(ref.get("id")) and text(ref.get("quote")), "Invalid source reference")
        require(ref["id"] in sources and ref["quote"] in sources[ref["id"]]["text"], "Source quote not found")
        for key in ("supersedes", "qualifies"):
            ids = fact.get(key, [])
            require(isinstance(ids, list) and all(text(x) for x in ids) and len(set(ids)) == len(ids), "Invalid relationship list")
        facts[fact["id"]] = fact

    superseded = set()
    for fact in rows:
        for key in ("supersedes", "qualifies"):
            require(all(i in facts and i != fact["id"] for i in fact.get(key, [])), "Unknown or self-referencing relationship")
        for old_id in fact.get("supersedes", []):
            old = facts[old_id]
            require(all(old[k] == fact[k] for k in ("topic", "key", "scope")), "Replacement must have the same topic, key and scope")
            require(sources[fact["source"]["id"]]["order"] > sources[old["source"]["id"]]["order"], "Replacement must cite a later source")
            superseded.add(old_id)
        if fact.get("qualifies"):
            require(fact["kind"] == "condition", "Only conditions qualify claims")
            require(all(facts[i]["kind"] in {"outcome", "decision", "action"} for i in fact["qualifies"]), "Condition must qualify a reportable claim")
        if fact["kind"] == "condition":
            require(bool(fact.get("qualifies")), "Condition needs a qualified claim")

    visiting, visited = set(), set()

    def visit(identifier):
        require(identifier not in visiting, "Cyclic replacement relationship")
        if identifier in visited:
            return
        visiting.add(identifier)
        for old in facts[identifier].get("supersedes", []):
            visit(old)
        visiting.remove(identifier)
        visited.add(identifier)

    for identifier in facts:
        visit(identifier)
    require(all(i in facts for i in selected), "Unknown selected fact")
    require(all(facts[i]["kind"] in {"outcome", "decision", "action"} for i in selected), "Select claims, not evidence or standalone conditions")
    require(not any(i in superseded for i in selected), "Selected fact is superseded; update the selection")
    for fact in rows:
        for old_id in fact.get("supersedes", []):
            if fact["kind"] in {"outcome", "decision", "action"}:
                for condition in rows:
                    if condition["kind"] == "condition" and old_id in condition.get("qualifies", []):
                        require(condition["id"] not in superseded and fact["id"] in condition.get("qualifies", []), "Replacement must explicitly carry its prior conditions; condition resolution is not supported")
    included, omitted, groups, actions = [], [], {}, []
    for identifier in selected:
        fact = facts[identifier]
        if fact.get("known", False) and not fact.get("supersedes"):
            omitted.append({"id": identifier, "reason": "already-known"})
            continue
        attached = [x for x in rows if x["kind"] == "condition" and identifier in x.get("qualifies", []) and x["id"] not in superseded]
        clauses = []
        for item in [fact, *attached]:
            if item["id"] not in included:
                included.append(item["id"])
                clause = item["clause"].strip().rstrip("。，；.!?！？;,")
                require(bool(clause), "Fact clause cannot consist only of punctuation")
                clauses.append(clause)
        if fact["kind"] == "action":
            actions.append("，".join(clauses))
        else:
            groups.setdefault(fact["topic"], []).extend(clauses)
    lines = ["，".join(clauses) for clauses in groups.values()]
    if actions:
        lines.append("下一步" + "；".join(actions))
    return {"report": "。".join(lines) + "。" if lines else "本次没有新增进展。", "included": included, "omitted": omitted, "semanticExtractionVerified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Version 1 JSON with full sources and extracted facts")
    args = parser.parse_args()
    try:
        result = render(read_json(args.input))
    except ValueError as error:
        # Parser messages can contain source excerpts; emit only our fixed validation messages.
        message = "Invalid JSON or UTF-8 input" if isinstance(error, (json.JSONDecodeError, UnicodeError)) else str(error)
        print(json.dumps({"ok": False, "error": message}), file=sys.stderr)
        return 2
    except OSError:
        print(json.dumps({"ok": False, "error": "Cannot read input"}), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
